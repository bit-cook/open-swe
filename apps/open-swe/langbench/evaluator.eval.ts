import * as ls from "langsmith/vitest";
import dotenv from "dotenv";
import { Daytona, Sandbox } from "@daytonaio/sdk";
import { createLogger, LogLevel } from "../src/utils/logger.js";
import { DEFAULT_SANDBOX_CREATE_PARAMS } from "../src/constants.js";
import { readFileSync } from "fs";
import { cloneRepo, checkoutFilesFromCommit } from "../src/utils/github/git.js";
import { TargetRepository } from "@open-swe/shared/open-swe/types";
import { getRepoAbsolutePath } from "@open-swe/shared/git";
import { setupEnv } from "../src/utils/env-setup.js";
import { PRData, PRProcessResult } from "./types.js";
import { runPytestOnFiles } from "./utils.js";
import { OpenSWEInput } from "../evals/open-swe-types.js";
import { exec } from "child_process";
import { promisify } from "util";

dotenv.config();

const logger = createLogger(LogLevel.INFO, "PR Processor");
const execPromise = promisify(exec);

// Load PRs data
const prsData: PRData[] = JSON.parse(
  readFileSync("langbench/static/langgraph_prs.json", "utf8"),
);

const DATASET = prsData.map((pr) => ({ inputs: pr }));
const DATASET_NAME = "langgraph-prs";

logger.info(`Starting evals over ${DATASET.length} PRs...`);

/**
 * Start the LangGraph Open-SWE server
 */
async function startLangGraphServer(): Promise<{ serverUrl: string; cleanup: () => Promise<void> }> {
  logger.info("Starting LangGraph Open-SWE server...");
  
  try {
    const { stdout } = await execPromise("npm run start:server", { 
      cwd: "/Users/palash/Desktop/open-swe/apps/open-swe",
      timeout: 30000 
    });
    
    const serverUrl = "http://localhost:8000"; // Default LangGraph server URL
    logger.info(`LangGraph server started at ${serverUrl}`);
    
    const cleanup = async () => {
      try {
        await execPromise("pkill -f 'langgraph'");
        logger.info("LangGraph server stopped");
      } catch (error) {
        logger.warn("Failed to stop LangGraph server:", error);
      }
    };
    
    return { serverUrl, cleanup };
  } catch (error) {
    throw new Error(`Failed to start LangGraph server: ${error}`);
  }
}

/**
 * Execute Open-SWE task and return the created PR branch name
 */
async function executeOpenSWETask(
  serverUrl: string,
  openSWEInput: OpenSWEInput
): Promise<string> {
  logger.info("Executing Open-SWE task...", { 
    repo: openSWEInput.repo, 
    userInput: openSWEInput.user_input.substring(0, 100) + "..." 
  });
  
  try {
    // Make request to LangGraph server to execute the Open-SWE task
    const response = await fetch(`${serverUrl}/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: openSWEInput,
        config: {
          configurable: {
            thread_id: `openswe-${Date.now()}`,
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Open-SWE task failed: ${response.statusText}`);
    }

    const result = await response.json();
    
    // Extract branch name from the result
    const branchName = result.branchName || result.output?.branchName;
    if (!branchName) {
      throw new Error("No branch name returned from Open-SWE task");
    }
    
    logger.info(`Open-SWE task completed, created branch: ${branchName}`);
    return branchName;
  } catch (error) {
    throw new Error(`Open-SWE task execution failed: ${error}`);
  }
}

/**
 * Clone the PR branch and run unit tests
 */
async function cloneBranchAndRunTests(
  prData: PRData, 
  branchName: string
): Promise<{
  testResults?: any;
  success: boolean;
  error?: string;
}> {
  const daytona = new Daytona({
    organizationId: process.env.DAYTONA_ORGANIZATION_ID,
  });
  let sandbox: Sandbox | undefined;

  try {
    logger.info(`Creating sandbox to test branch: ${branchName}`);
    sandbox = await daytona.create(DEFAULT_SANDBOX_CREATE_PARAMS);

    if (!sandbox || !sandbox.id) {
      throw new Error("Failed to create valid sandbox");
    }

    // Clone the repository with the specific branch
    const targetRepository: TargetRepository = {
      owner: prData.repoOwner,
      repo: prData.repoName,
      branch: branchName,
      baseCommit: undefined,
    };

    const githubToken = process.env.GITHUB_PAT;
    if (!githubToken) {
      throw new Error("GITHUB_PAT environment variable is required");
    }

    await cloneRepo(sandbox, targetRepository, {
      githubInstallationToken: githubToken,
      stateBranchName: branchName,
    });

    const repoDir = getRepoAbsolutePath(targetRepository);

    // Setup Python environment
    logger.info("Setting up Python environment...");
    const envSetupSuccess = await setupEnv(sandbox, repoDir);
    if (!envSetupSuccess) {
      logger.warn("Failed to setup Python environment, continuing anyway");
    }

    // Checkout the original unit test files
    const testFiles = prData.testFiles || [];
    if (testFiles.length > 0) {
      logger.info("Checking out original unit test files...");
      await checkoutFilesFromCommit({
        sandbox,
        repoDir,
        commitSha: prData.preMergeCommitSha,
        filePaths: testFiles,
      });

      // Run the unit tests
      logger.info(`Running unit tests on ${testFiles.length} files...`);
      const testResults = await runPytestOnFiles({
        sandbox,
        testFiles,
        repoDir,
        timeoutSec: 300,
      });

      return {
        testResults,
        success: true,
      };
    } else {
      logger.info("No test files to run");
      return {
        success: true,
      };
    }
  } catch (error) {
    logger.error("Failed to clone branch and run tests:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (sandbox) {
      try {
        await sandbox.delete();
        logger.info(`Deleted sandbox: ${sandbox.id}`);
      } catch (cleanupError) {
        logger.warn(`Failed to cleanup sandbox ${sandbox.id}:`, { cleanupError });
      }
    }
  }
}

/**
 * Process a single PR with Open-SWE workflow
 */
async function processPRWithOpenSWE(prData: PRData): Promise<PRProcessResult & {
  openSWEBranch?: string;
  openSWETestResults?: any;
}> {
  const result: PRProcessResult & {
    openSWEBranch?: string;
    openSWETestResults?: any;
  } = {
    prNumber: prData.prNumber,
    repoName: prData.repoName,
    success: false,
    evalsFound: false,
    evalsFiles: [],
    testFiles: prData.testFiles || [],
  };

  let langGraphCleanup: (() => Promise<void>) | undefined;

  try {
    logger.info(`Processing PR #${prData.prNumber} with Open-SWE workflow: ${prData.title}`);

    // Step 1: Start LangGraph Open-SWE server
    const { serverUrl, cleanup } = await startLangGraphServer();
    langGraphCleanup = cleanup;

    // Step 2: Create Open-SWE input from PR data
    const openSWEInput: OpenSWEInput = {
      user_input: prData.title + "\n\n" + (prData.body || ""),
      repo: `${prData.repoOwner}/${prData.repoName}`,
      branch: "main", // Start from main branch
    };

    // Step 3: Execute Open-SWE task and get the created PR branch
    const openSWEBranch = await executeOpenSWETask(serverUrl, openSWEInput);
    result.openSWEBranch = openSWEBranch;

    // Step 4: Clone the Open-SWE branch and run unit tests
    const testResult = await cloneBranchAndRunTests(prData, openSWEBranch);
    
    if (testResult.success) {
      result.openSWETestResults = testResult.testResults;
      result.success = true;
    } else {
      result.error = testResult.error;
    }

    logger.info(`Successfully processed PR #${prData.prNumber} with Open-SWE`);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to process PR #${prData.prNumber} with Open-SWE:`, { error });
  } finally {
    // Cleanup LangGraph server
    if (langGraphCleanup) {
      await langGraphCleanup();
    }
  }

  return result;
}

/**
 * Process a single PR (original workflow)
 */
async function processPR(prData: PRData): Promise<PRProcessResult> {
  const result: PRProcessResult = {
    prNumber: prData.prNumber,
    repoName: prData.repoName,
    success: false,
    evalsFound: false,
    evalsFiles: [],
    testFiles: [],
  };
  const daytona = new Daytona({
    organizationId: process.env.DAYTONA_ORGANIZATION_ID,
  });
  let sandbox: Sandbox | undefined;

  try {
    logger.info(`Processing PR #${prData.prNumber}: ${prData.title}`);

    // Use test files from PR data (already fetched and stored)
    const testFiles = prData.testFiles || [];
    result.testFiles = testFiles;
    // Create sandbox
    sandbox = await daytona.create(DEFAULT_SANDBOX_CREATE_PARAMS);

    // Validate sandbox was created properly
    if (!sandbox || !sandbox.id) {
      throw new Error("Failed to create valid sandbox");
    }

    result.workspaceId = sandbox.id;
    logger.info(`Created sandbox: ${sandbox.id}`);

    // Use the hardcoded pre-merge commit SHA from the dataset
    const preMergeCommit = prData.preMergeCommitSha;
    logger.info(`Using pre-merge commit: ${preMergeCommit}`);
    result.preMergeSha = preMergeCommit;

    const targetRepository: TargetRepository = {
      owner: prData.repoOwner,
      repo: prData.repoName,
      branch: undefined,
      baseCommit: preMergeCommit,
    };
    const repoDir = getRepoAbsolutePath(targetRepository);

    // Clone and checkout the repository at the pre-merge commit
    const githubToken = process.env.GITHUB_PAT;
    if (!githubToken) {
      throw new Error("GITHUB_PAT environment variable is required");
    }

    await cloneRepo(sandbox, targetRepository, {
      githubInstallationToken: githubToken,
    });

    // Setup Python environment
    logger.info("Setting up Python environment...");
    const envSetupSuccess = await setupEnv(sandbox, repoDir);
    if (!envSetupSuccess) {
      logger.warn("Failed to setup Python environment, continuing anyway");
    }

    // Checkout test files from the merge commit to get the updated test files
    if (testFiles.length > 0) {
      logger.info(
        `Checking out test files from merge commit: ${prData.mergeCommitSha}`,
      );
      await checkoutFilesFromCommit({
        sandbox,
        repoDir,
        commitSha: prData.mergeCommitSha,
        filePaths: testFiles,
      });
    }

    // Run tests on detected test files
    if (testFiles.length > 0) {
      logger.info(
        `Running pytest on ${testFiles.length} detected test files...`,
      );
      const testResults = await runPytestOnFiles({
        sandbox,
        testFiles,
        repoDir,
        timeoutSec: 300,
      });
      result.testResults = testResults;

      logger.info(`Test execution completed for PR #${prData.prNumber}`, {
        totalTests: testResults.totalTests,
        passedTests: testResults.passedTests,
        failedTests: testResults.failedTests,
        success: testResults.success,
      });
    } else {
      logger.info(`No test files to run for PR #${prData.prNumber}`);
    }

    result.success = true;
    logger.info(`Successfully processed PR #${prData.prNumber}`);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to process PR #${prData.prNumber}:`, { error });
  } finally {
    // Cleanup sandbox
    if (sandbox) {
      try {
        await sandbox.delete();
        logger.info(`Deleted sandbox: ${sandbox.id}`);
      } catch (cleanupError) {
        logger.warn(`Failed to cleanup sandbox ${sandbox.id}:`, {
          cleanupError,
        });
      }
    }
  }

  return result;
}

ls.describe(DATASET_NAME, () => {
  ls.test.each(DATASET)(
    "Can process PR successfully (original workflow)",
    async ({ inputs: prData }) => {
      logger.info(`Processing PR #${prData.prNumber}: ${prData.title}`);

      const result = await processPR(prData);

      // Log results for visibility
      logger.info(`PR #${prData.prNumber} processing completed`, {
        success: result.success,
        evalsFound: result.evalsFound,
        evalsFilesCount: result.evalsFiles.length,
        testFilesCount: result.testFiles.length,
        testFiles: result.testFiles,
        testResults: result.testResults
          ? {
              totalTests: result.testResults.totalTests,
              passedTests: result.testResults.passedTests,
              failedTests: result.testResults.failedTests,
              success: result.testResults.success,
            }
          : null,
        error: result.error,
        workspaceId: result.workspaceId,
        preMergeSha: result.preMergeSha,
      });

      // Assert that processing was successful
      if (!result.success) {
        throw new Error(`PR processing failed: ${result.error}`);
      }
    },
    300_000, // 5 minute timeout per PR
  );

  ls.test.each(DATASET)(
    "Can process PR with Open-SWE workflow",
    async ({ inputs: prData }) => {
      logger.info(`Processing PR #${prData.prNumber} with Open-SWE: ${prData.title}`);

      const result = await processPRWithOpenSWE(prData);

      // Log results for visibility
      logger.info(`PR #${prData.prNumber} Open-SWE processing completed`, {
        success: result.success,
        openSWEBranch: result.openSWEBranch,
        testFilesCount: result.testFiles.length,
        testFiles: result.testFiles,
        openSWETestResults: result.openSWETestResults
          ? {
              totalTests: result.openSWETestResults.totalTests,
              passedTests: result.openSWETestResults.passedTests,
              failedTests: result.openSWETestResults.failedTests,
              success: result.openSWETestResults.success,
            }
          : null,
        error: result.error,
      });

      // Assert that processing was successful
      if (!result.success) {
        throw new Error(`Open-SWE PR processing failed: ${result.error}`);
      }

      // Assert that we got an Open-SWE branch name
      if (!result.openSWEBranch) {
        throw new Error("No Open-SWE branch name was returned");
      }
    },
    600_000, // 10 minute timeout per PR (longer for Open-SWE workflow)
  );
});
