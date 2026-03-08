import * as fs from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';

/**
 * Parsed result for a single test case.
 */
export interface TestResult {
    /** `true` if the test case had no failure or skip elements. */
    passed: boolean;
    /** `true` if the test case contained a `<failure>` element. */
    failed: boolean;
    /** `true` if the test case contained a `<skipped>` element. */
    skipped: boolean;
    /** Test execution duration in milliseconds, derived from the `time` attribute. */
    duration?: number;
    /** Human-readable failure message from the `<failure message="...">` attribute. */
    errorMessage?: string;
    /** Full stack trace from the text content of the `<failure>` element. */
    errorStackTrace?: string;
    /** 0-based line number of the failing statement, extracted from the stack trace. */
    failureLineNumber?: number;
    /** Source file name (e.g. `"CalculatorTest.kt"`) extracted from the stack trace. */
    failureFile?: string;
}

/**
 * Parses JUnit-format XML test result files produced by Gradle's `test` task.
 *
 * Each XML file (`TEST-*.xml`) represents one test class. The parser reads all
 * XML files from a given directory and builds a map from fully-qualified test
 * names to their parsed results.
 *
 * The fully-qualified key format is: `"com.example.ClassName.methodName"`
 *
 * Method name normalisation: Gradle appends `()` to method names when no `@DisplayName`
 * is present. This suffix is stripped so the key matches the VS Code `TestItem.id` format.
 */
export class ResultParser {

    /**
     * Reads and parses all JUnit XML files in the given directory.
     *
     * Returns an empty map if the directory does not exist (e.g. when no tests
     * have been run yet or the build failed before producing results).
     *
     * @param xmlResultsPath - Absolute path to the directory containing `TEST-*.xml` files.
     * @returns A promise resolving to a map from fully-qualified test name to `TestResult`.
     */
    async parseResults(xmlResultsPath: string): Promise<Map<string, TestResult>> {
        const results = new Map<string, TestResult>();

        if (!fs.existsSync(xmlResultsPath)) {
            return results;
        }

        const xmlFiles = fs.readdirSync(xmlResultsPath)
            .filter(f => f.endsWith('.xml'))
            .map(f => path.join(xmlResultsPath, f));

        for (const xmlFile of xmlFiles) {
            await this.parseXmlFile(xmlFile, results);
        }

        return results;
    }

    /**
     * Parses a single JUnit XML file and adds its test case results to the provided map.
     *
     * For each `<testcase>` element the following is extracted:
     * - `classname` and `name` attributes to form the fully-qualified key
     * - `time` attribute (seconds) converted to milliseconds
     * - `<failure>` child element for error message and stack trace
     * - `<skipped>` child element to detect skipped tests
     *
     * HTML entities (`&lt;` / `&gt;`) in failure messages are decoded.
     *
     * @param filePath - Absolute path to the XML file to parse.
     * @param results - The result map to populate.
     */
    private async parseXmlFile(
        filePath: string,
        results: Map<string, TestResult>
    ): Promise<void> {
        const content = fs.readFileSync(filePath, 'utf-8');
        const parsed = await xml2js.parseStringPromise(content);
        const testSuite = parsed.testsuite;

        if (!testSuite?.testcase) {
            return;
        }

        for (const testCase of testSuite.testcase) {
            const className = testCase.$.classname;
            const methodName = testCase.$.name;
            const duration = parseFloat(testCase.$.time ?? '0') * 1000;

            // Gradle appends "()" to method names when there is no @DisplayName annotation.
            // Strip the suffix to match the TestItem id used in VS Code.
            const cleanName = methodName.endsWith('()')
                ? methodName.slice(0, -2)
                : methodName;

            const fullyQualifiedName = `${className}.${cleanName}`;

            const failed = testCase.failure !== undefined;
            const skipped = testCase.skipped !== undefined;

            let errorMessage: string | undefined;
            let errorStackTrace: string | undefined;
            let failureLineNumber: number | undefined;
            let failureFile: string | undefined;

            if (failed) {
                errorMessage = testCase.failure[0].$.message
                    ?.replace(/&lt;/g, '<')
                    ?.replace(/&gt;/g, '>');

                errorStackTrace = testCase.failure[0]._;

                const lineInfo = this.extractLineNumber(
                    errorStackTrace ?? '',
                    className
                );
                failureLineNumber = lineInfo?.lineNumber;
                failureFile = lineInfo?.fileName;
            }

            results.set(fullyQualifiedName, {
                passed: !failed && !skipped,
                failed,
                skipped,
                duration,
                errorMessage,
                errorStackTrace,
                failureLineNumber,
                failureFile
            });
        }
    }

    /**
     * Extracts the source file name and 0-based line number of the failing statement
     * from a Java stack trace.
     *
     * Searches for a stack frame that matches the pattern:
     * `at ...SimpleClassName.method(SimpleClassName.kt:N)`
     *
     * The line number reported in stack traces is 1-indexed; this method subtracts 1
     * to return a 0-based value suitable for use with the VS Code `Position` API.
     *
     * @param stackTrace - The full stack trace text from the `<failure>` element.
     * @param className - The fully-qualified class name (used to derive the simple name).
     * @returns An object with `fileName` and 0-based `lineNumber`, or `null` if not found.
     */
    private extractLineNumber(
        stackTrace: string,
        className: string
    ): { fileName: string; lineNumber: number } | null {
        const simpleClassName = className.split('.').pop() ?? className;

        const pattern = new RegExp(
            `at[^(]+${simpleClassName}\\.([^(]+)\\(${simpleClassName}\\.kt:(\\d+)\\)`
        );
        const match = stackTrace.match(pattern);

        if (match) {
            return {
                fileName: `${simpleClassName}.kt`,
                lineNumber: parseInt(match[2], 10) - 1
            };
        }

        return null;
    }
}
