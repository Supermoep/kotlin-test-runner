import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Configuration for a single named test source set.
 * Corresponds to one entry in the `kotlinTestRunner.testSourceSets` setting.
 */
export interface SourceSetConfig {
    /** Label shown as a group node in the Test Explorer when multiple source sets are configured. */
    name: string;
    /** Path to the test source directory, relative to the workspace root (e.g. `"src/test/kotlin"`). */
    path: string;
}

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
    /** Name of the source set this class was discovered in (from {@link SourceSetConfig.name}). */
    sourceSetName: string;
}

/**
 * Scans the workspace's Kotlin test sources and extracts test class and method metadata
 * using regex-based static analysis.
 *
 * Each {@link SourceSetConfig} specifies a named directory (relative to the workspace root)
 * to scan recursively for `.kt` files. No Kotlin compiler or language server is invoked —
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
     * Discovers all Kotlin test classes across the given source sets.
     *
     * For each {@link SourceSetConfig}, the directory `{workspaceRoot}/{sourceSet.path}` is
     * scanned recursively for `.kt` files. Only classes that contain at least one
     * `@Test`-annotated method are returned. Each returned {@link TestClass} carries the
     * `sourceSetName` of the set it was discovered in.
     *
     * @param workspaceRoot - Absolute path to the workspace root directory.
     * @param sourceSets - Named source set configurations to scan.
     * @returns A promise resolving to an array of discovered test classes.
     */
    async discoverTests(workspaceRoot: string, sourceSets: SourceSetConfig[]): Promise<TestClass[]> {
        const testClasses: TestClass[] = [];

        for (const sourceSet of sourceSets) {
            const absoluteDir = path.join(workspaceRoot, sourceSet.path);
            const kotlinFiles = this.findKotlinTestFiles(absoluteDir);

            for (const filePath of kotlinFiles) {
                const testClass = await this.parseKotlinFile(filePath);
                if (testClass && testClass.methods.length > 0) {
                    testClass.sourceSetName = sourceSet.name;
                    testClasses.push(testClass);
                }
            }
        }

        return testClasses;
    }

    /**
     * Returns all `.kt` files inside the given absolute directory, recursively.
     *
     * Shows a VS Code warning if the directory does not exist and returns an empty array.
     *
     * @param absoluteDir - Absolute path to the test source directory to scan.
     * @returns Absolute paths to all discovered Kotlin source files.
     */
    private findKotlinTestFiles(absoluteDir: string): string[] {
        if (!fs.existsSync(absoluteDir)) {
            vscode.window.showWarningMessage(
                `No test source directory found: ${absoluteDir}`
            );
            return [];
        }

        return this.walkDirectory(absoluteDir, '.kt');
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
     * The `sourceSetName` field is left as an empty string and must be set by the caller.
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
            methods,
            sourceSetName: ''
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
