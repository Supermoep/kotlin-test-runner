import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Represents a single `@Test`-annotated method discovered in a Kotlin source file.
 */
export interface TestMethod {
    /** Raw Kotlin function name, used as the Gradle `--tests` filter. */
    name: string;
    /** Human-readable name from `@DisplayName`, or the raw function name if no annotation is present. */
    displayName: string;
    /** `true` if a `@DisplayName` annotation was found for this method. */
    hasDisplayName: boolean;
    /** 0-based line number of the `fun` declaration within the source file. */
    line: number;
}

/**
 * Represents a Kotlin test class and all of its discovered test methods.
 */
export interface TestClass {
    /** Simple (unqualified) class name, e.g. `"CalculatorTest"`. */
    name: string;
    /** Kotlin package declaration, e.g. `"com.example"`. */
    packageName: string;
    /** Fully-qualified class name, e.g. `"com.example.CalculatorTest"`. */
    fullyQualifiedName: string;
    /** Absolute path to the `.kt` source file. */
    filePath: string;
    /** All `@Test`-annotated methods found in this class. */
    methods: TestMethod[];
}

/**
 * Scans the workspace's Kotlin test sources and extracts test class and method metadata
 * using regex-based static analysis.
 *
 * The conventional test source directory `{workspaceRoot}/src/test/kotlin/` is scanned
 * recursively for `.kt` files. No Kotlin compiler or language server is invoked —
 * all information is extracted via regular expressions applied to the raw source text.
 */
export class KotlinTestDiscovery {

    /** Matches a `@Test` annotation token on a line. */
    private static readonly TEST_ANNOTATION = /@Test/;

    /** Captures the display name string from a `@DisplayName("...")` annotation. */
    private static readonly DISPLAY_NAME_ANNOTATION = /@DisplayName\("(.+)"\)/;

    /** Captures the simple class name from a top-level `class` declaration. */
    private static readonly CLASS_PATTERN = /^class\s+(\w+)/m;

    /** Captures the package name from a `package` declaration. */
    private static readonly PACKAGE_PATTERN = /^package\s+([\w.]+)/m;

    /**
     * Captures the function name from a `fun` declaration.
     * Handles both regular identifiers and backtick-quoted names (e.g. `` fun `my test`() ``).
     */
    private static readonly FUN_PATTERN = /fun\s+`?([^`(]+)`?\s*\(/;

    /**
     * Discovers all Kotlin test classes in the workspace.
     *
     * Scans all `.kt` files under `{workspaceRoot}/src/test/kotlin/`, parses each file,
     * and returns only classes that contain at least one `@Test`-annotated method.
     *
     * @param workspaceRoot - Absolute path to the workspace root directory.
     * @returns A promise resolving to an array of discovered test classes.
     */
    async discoverTests(workspaceRoot: string): Promise<TestClass[]> {
        const testClasses: TestClass[] = [];
        const kotlinFiles = await this.findKotlinTestFiles(workspaceRoot);

        for (const filePath of kotlinFiles) {
            const testClass = await this.parseKotlinFile(filePath);
            if (testClass && testClass.methods.length > 0) {
                testClasses.push(testClass);
            }
        }

        return testClasses;
    }

    /**
     * Returns all `.kt` files inside `{workspaceRoot}/src/test/kotlin/`.
     *
     * Shows a VS Code warning if the directory does not exist and returns an empty array.
     *
     * @param workspaceRoot - Absolute path to the workspace root directory.
     * @returns Absolute paths to all discovered Kotlin source files.
     */
    private async findKotlinTestFiles(workspaceRoot: string): Promise<string[]> {
        const testSourceDir = path.join(workspaceRoot, 'src', 'test', 'kotlin');

        if (!fs.existsSync(testSourceDir)) {
            vscode.window.showWarningMessage(
                `No test source directory found: ${testSourceDir}`
            );
            return [];
        }

        return this.walkDirectory(testSourceDir, '.kt');
    }

    /**
     * Recursively walks a directory and collects all files with the given extension.
     *
     * @param dir - Absolute path to the directory to walk.
     * @param extension - File extension to match, including the leading dot (e.g. `".kt"`).
     * @returns Absolute paths to all matching files.
     */
    private walkDirectory(dir: string, extension: string): string[] {
        const results: string[] = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push(...this.walkDirectory(fullPath, extension));
            } else if (entry.name.endsWith(extension)) {
                results.push(fullPath);
            }
        }

        return results;
    }

    /**
     * Parses a single Kotlin source file and extracts its test class metadata.
     *
     * Returns `null` if the file does not contain a class declaration.
     * Methods are extracted via {@link extractTestMethods}.
     *
     * @param filePath - Absolute path to the `.kt` file to parse.
     * @returns A `TestClass` object, or `null` if no class declaration is found.
     */
    async parseKotlinFile(filePath: string): Promise<TestClass | null> {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        const packageMatch = content.match(KotlinTestDiscovery.PACKAGE_PATTERN);
        const classMatch = content.match(KotlinTestDiscovery.CLASS_PATTERN);

        if (!classMatch) {
            return null;
        }

        const packageName = packageMatch ? packageMatch[1] : '';
        const className = classMatch[1];
        const fullyQualifiedName = packageName
            ? `${packageName}.${className}`
            : className;

        const methods = this.extractTestMethods(lines);

        return {
            name: className,
            packageName,
            fullyQualifiedName,
            filePath,
            methods
        };
    }

    /**
     * Extracts all `@Test`-annotated methods from the given source lines.
     *
     * For each `@Test` found at line `i`:
     * - Searches lines `[i-3, i-1]` and `[i+1, i+3]` for a `@DisplayName` annotation.
     *   This range accommodates both orderings (`@DisplayName` before or after `@Test`).
     * - Searches lines `[i+1, i+4]` for the `fun` declaration, allowing for additional
     *   annotations between `@Test` and the function keyword.
     *
     * @param lines - Lines of a Kotlin source file.
     * @returns An array of `TestMethod` descriptors.
     */
    private extractTestMethods(lines: string[]): TestMethod[] {
        const methods: TestMethod[] = [];

        for (let i = 0; i < lines.length; i++) {
            if (!KotlinTestDiscovery.TEST_ANNOTATION.test(lines[i])) {
                continue;
            }

            // Search for @DisplayName in a window of 3 lines before AND after @Test.
            let displayName = '';
            const searchRange = [
                ...Array.from({length: 3}, (_, k) => i - 3 + k),
                ...Array.from({length: 3}, (_, k) => i + 1 + k)
            ];

            for (const k of searchRange) {
                if (k < 0 || k >= lines.length) { continue; }
                const match = lines[k]?.match(
                    KotlinTestDiscovery.DISPLAY_NAME_ANNOTATION
                );
                if (match) {
                    displayName = match[1];
                    break;
                }
            }

            // Search for the fun declaration in the next 4 lines after @Test.
            for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
                const funMatch = lines[j].match(KotlinTestDiscovery.FUN_PATTERN);
                if (funMatch) {
                    const name = funMatch[1].trim();
                    methods.push({
                        name,
                        displayName: displayName || name,
                        hasDisplayName: displayName !== '',
                        line: j
                    });
                    break;
                }
            }
        }

        return methods;
    }
}
