import * as fs from 'fs';
import * as path from 'path';
import * as xml2js from 'xml2js';

export interface TestResult {
    passed: boolean;
    failed: boolean;
    skipped: boolean;
    duration?: number;
    errorMessage?: string;
    errorStackTrace?: string;
    failureLineNumber?: number;
    failureFile?: string;
}

export class ResultParser {

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

            // () am Ende entfernen – nur vorhanden wenn kein @DisplayName
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