import * as vscode from 'vscode';
import { KotlinTestDiscovery } from './core/KotlinTestDiscovery';
import { GradleBridge } from './core/GradleBridge';
import { ResultParser } from './core/ResultParser';

export async function activate(context: vscode.ExtensionContext) {
    console.log('Kotlin Test Runner wird aktiviert...');

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('Kein Workspace geöffnet.');
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
                                result.errorMessage ?? 'Test fehlgeschlagen',
                                '',
                                result.errorStackTrace
                                    ? `Stacktrace:\n${result.errorStackTrace}`
                                    : ''
                            ].filter(Boolean).join('\n');

                            const message = new vscode.TestMessage(errorText);

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
                            if (gradleResult.success) {
                                run.passed(testItem);
                            } else {
                                run.failed(
                                    testItem,
                                    new vscode.TestMessage(
                                        `Kein Testergebnis gefunden.\nGradle Output:\n${gradleResult.output}`
                                    )
                                );
                            }
                        }
                    }
                } catch (error) {
                    testItems.forEach(([item]) =>
                        run.errored(item, new vscode.TestMessage(`Fehler: ${error}`))
                    );
                }
            }

            run.end();
        }
    );

    console.log('Kotlin Test Runner aktiv.');
}

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

    console.log(`${testClasses.length} Testklassen gefunden.`);
}

export function deactivate() {}