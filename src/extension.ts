import * as vscode from 'vscode';
import { KotlinTestDiscovery } from './core/KotlinTestDiscovery';
import { GradleBridge } from './core/GradleBridge';
import { ResultParser } from './core/ResultParser';

/**
 * Extension entry point called by VS Code when the extension is activated.
 *
 * Activation is triggered when the workspace contains `.kt` files
 * (`workspaceContains:**\/*.kt`) or after VS Code finishes starting up
 * (`onStartupFinished`), as declared in `package.json`.
 *
 * This function:
 * 1. Instantiates the three core components (`KotlinTestDiscovery`, `GradleBridge`, `ResultParser`).
 * 2. Creates and registers a VS Code `TestController`.
 * 3. Performs an initial test discovery pass.
 * 4. Sets up a `FileSystemWatcher` to refresh the test tree on any `.kt` file change.
 * 5. Registers a `Run` test profile that orchestrates the full test execution pipeline.
 *
 * @param context - The VS Code extension context used for registering disposables.
 */
export async function activate(context: vscode.ExtensionContext) {
    console.log('Kotlin Test Runner activating...');

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder is open.');
        return;
    }

    const discovery = new KotlinTestDiscovery();
    const gradleBridge = new GradleBridge(workspaceRoot);
    const resultParser = new ResultParser();

    const controller = vscode.tests.createTestController(
        'kotlinTestRunner',
        'Kotlin Test Runner'
    );
    context.subscriptions.push(controller);

    await loadTests(controller, discovery, workspaceRoot);

    // Re-discover tests whenever any Kotlin file is created, changed, or deleted.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.kt');
    watcher.onDidChange(() => loadTests(controller, discovery, workspaceRoot));
    watcher.onDidCreate(() => loadTests(controller, discovery, workspaceRoot));
    watcher.onDidDelete(() => loadTests(controller, discovery, workspaceRoot));
    context.subscriptions.push(watcher);

    controller.createRunProfile(
        'Run',
        vscode.TestRunProfileKind.Run,
        async (request, token) => {
            const run = controller.createTestRun(request);
            const testsToRun = collectTests(request, controller);

            if (testsToRun.size === 0) {
                run.end();
                return;
            }

            // Group tests by class so each class is executed in a single Gradle invocation,
            // avoiding repeated JVM startup overhead.
            const groupedByClass = groupTestsByClass(testsToRun);

            for (const [className, testItems] of groupedByClass) {
                testItems.forEach(([item]) => run.started(item));

                try {
                    const gradleFilters = testItems.map(([, filter]) => filter);
                    const gradleResult = await gradleBridge.runTests(gradleFilters);

                    const testResults = await resultParser.parseResults(
                        gradleResult.xmlResultsPath
                    );

                    for (const [testItem] of testItems) {
                        const searchKey = testItem.id.trim();
                        let result = testResults.get(searchKey);

                        // Fall back to case-insensitive lookup to guard against
                        // casing discrepancies between VS Code IDs and Gradle XML output.
                        if (!result) {
                            const lowerSearch = searchKey.toLowerCase();
                            for (const [key, value] of testResults.entries()) {
                                if (key.toLowerCase() === lowerSearch) {
                                    result = value;
                                    break;
                                }
                            }
                        }

                        if (result?.passed) {
                            run.passed(testItem, result.duration);
                        } else if (result?.failed) {
                            const errorText = [
                                result.errorMessage ?? 'Test failed',
                                '',
                                result.errorStackTrace
                                    ? `Stack trace:\n${result.errorStackTrace}`
                                    : ''
                            ].filter(Boolean).join('\n');

                            const message = new vscode.TestMessage(errorText);

                            // Prefer the exact failing line from the stack trace;
                            // fall back to the method declaration range if unavailable.
                            if (testItem.uri && result.failureLineNumber !== undefined) {
                                message.location = new vscode.Location(
                                    testItem.uri,
                                    new vscode.Range(
                                        new vscode.Position(result.failureLineNumber, 0),
                                        new vscode.Position(result.failureLineNumber, 0)
                                    )
                                );
                            } else if (testItem.uri && testItem.range) {
                                message.location = new vscode.Location(
                                    testItem.uri,
                                    testItem.range
                                );
                            }

                            run.failed(testItem, message, result.duration);
                        } else {
                            // No XML result found for this test — use Gradle exit code as proxy.
                            if (gradleResult.success) {
                                run.passed(testItem);
                            } else {
                                run.failed(
                                    testItem,
                                    new vscode.TestMessage(
                                        `No test result found.\nGradle output:\n${gradleResult.output}`
                                    )
                                );
                            }
                        }
                    }
                } catch (error) {
                    testItems.forEach(([item]) =>
                        run.errored(item, new vscode.TestMessage(`Error: ${error}`))
                    );
                }
            }

            run.end();
        }
    );

    console.log('Kotlin Test Runner active.');
}

/**
 * Recursively collects all leaf `TestItem`s from the given run request.
 *
 * A leaf item is a `TestItem` with no children — i.e. an individual test method.
 * For each leaf, the Gradle filter string is read from the item's `gradle:` tag.
 * If no such tag exists, the item's `id` is used as a fallback.
 *
 * @param request - The VS Code test run request, which may specify a subset of tests to run.
 * @param controller - The `TestController` used to iterate all items when no explicit include list is given.
 * @returns A map from each leaf `TestItem` to its Gradle `--tests` filter string.
 */
function collectTests(
    request: vscode.TestRunRequest,
    controller: vscode.TestController
): Map<vscode.TestItem, string> {
    const tests = new Map<vscode.TestItem, string>();

    const collectItem = (item: vscode.TestItem) => {
        if (item.children.size > 0) {
            item.children.forEach(child => collectItem(child));
        } else {
            const gradleFilter = item.tags
                .find(t => t.id.startsWith('gradle:'))
                ?.id.replace('gradle:', '') ?? item.id;
            tests.set(item, gradleFilter);
        }
    };

    if (request.include) {
        request.include.forEach(item => collectItem(item));
    } else {
        controller.items.forEach(item => collectItem(item));
    }

    return tests;
}

/**
 * Groups a flat map of tests by their fully-qualified class name.
 *
 * The class name is derived from the Gradle filter string by taking everything
 * before the last `.`. Tests are batched by class so that a single Gradle
 * invocation handles all selected methods within a class, avoiding repeated
 * JVM startup overhead.
 *
 * @param testsToRun - Map of `TestItem` to Gradle filter string (e.g. `"com.example.MyTest.myMethod"`).
 * @returns A map from class name to an array of `[TestItem, gradleFilter]` pairs.
 */
function groupTestsByClass(
    testsToRun: Map<vscode.TestItem, string>
): Map<string, [vscode.TestItem, string][]> {
    const grouped = new Map<string, [vscode.TestItem, string][]>();

    for (const [testItem, gradleFilter] of testsToRun) {
        const lastDot = gradleFilter.lastIndexOf('.');
        const className = lastDot > 0
            ? gradleFilter.substring(0, lastDot)
            : gradleFilter;

        if (!grouped.has(className)) {
            grouped.set(className, []);
        }
        grouped.get(className)!.push([testItem, gradleFilter]);
    }

    return grouped;
}

/**
 * Rebuilds the entire VS Code test item tree by running a fresh discovery pass.
 *
 * Clears all existing items from the controller and repopulates them from the
 * discovered test classes. Each class becomes a parent `TestItem`; its methods
 * become child `TestItem`s with:
 * - `id` set to `{FQN}.{displayName}` (used for result matching)
 * - a `gradle:{FQN}.{methodName}` tag (the raw name used as the Gradle `--tests` filter)
 * - `range` pointing to the method's declaration line in the source file
 *
 * @param controller - The `TestController` whose item tree will be replaced.
 * @param discovery - The discovery component used to find test classes.
 * @param workspaceRoot - Absolute path to the workspace root directory.
 */
async function loadTests(
    controller: vscode.TestController,
    discovery: KotlinTestDiscovery,
    workspaceRoot: string
) {
    controller.items.replace([]);
    const testClasses = await discovery.discoverTests(workspaceRoot);

    for (const testClass of testClasses) {
        const classItem = controller.createTestItem(
            testClass.fullyQualifiedName,
            testClass.name,
            vscode.Uri.file(testClass.filePath)
        );

        for (const method of testClass.methods) {
            const methodItem = controller.createTestItem(
                `${testClass.fullyQualifiedName}.${method.displayName}`,
                method.displayName,
                vscode.Uri.file(testClass.filePath)
            );

            // Store the raw method name as a tag so Gradle receives the correct filter.
            // The TestItem id uses displayName for readability, but Gradle requires
            // the actual Kotlin function name.
            methodItem.tags = [
                new vscode.TestTag(
                    `gradle:${testClass.fullyQualifiedName}.${method.name}`
                )
            ];

            methodItem.range = new vscode.Range(
                new vscode.Position(method.line, 0),
                new vscode.Position(method.line, 0)
            );
            classItem.children.add(methodItem);
        }

        controller.items.add(classItem);
    }

    console.log(`${testClasses.length} test class(es) discovered.`);
}

/**
 * Called by VS Code when the extension is deactivated (e.g. window close, disable).
 * Cleanup is handled via `context.subscriptions` registered in `activate`.
 */
export function deactivate() {}
