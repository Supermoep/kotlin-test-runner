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

    /**
     * Parst alle JUnit XML Ergebnisdateien aus dem Gradle Output.
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
            // classname steht im testcase Attribut – nicht im testsuite
            const className = testCase.$.classname;
            const methodName = testCase.$.name;
            const duration = parseFloat(testCase.$.time ?? '0') * 1000;
            const fullyQualifiedName = `${className}.${methodName}`;
            // Zusätzlich lowercase Key für Kotlin Backtick-Methoden
            const lowerKey = `${className}.${methodName.toLowerCase()}`;

            const failed = testCase.failure !== undefined;
            const skipped = testCase.skipped !== undefined;

            let errorMessage: string | undefined;
            let errorStackTrace: string | undefined;
            let failureLineNumber: number | undefined;
            let failureFile: string | undefined;

            if (failed) {
                // Fehlermeldung aus dem message Attribut
                errorMessage = testCase.failure[0].$.message
                    ?.replace(/&lt;/g, '<')
                    ?.replace(/&gt;/g, '>');

                // Stacktrace ist der Text-Inhalt des failure Elements
                errorStackTrace = testCase.failure[0]._;

                // Zeilennummer aus Stacktrace extrahieren
                // Format: SensorDataProcessorTest.kt:36
                const lineInfo = this.extractLineNumber(
                    errorStackTrace ?? '',
                    className
                );
                failureLineNumber = lineInfo?.lineNumber;
                failureFile = lineInfo?.fileName;
            }

            const testResult: TestResult = {
                passed: !failed && !skipped,
                failed,
                skipped,
                duration,
                errorMessage,
                errorStackTrace,
                failureLineNumber,
                failureFile
            };

            results.set(fullyQualifiedName, testResult);

            // Lowercase Variante als Fallback
            if (lowerKey !== fullyQualifiedName) {
                results.set(lowerKey, testResult);
            }
        }
    }

    /**
     * Extrahiert Dateiname und Zeilennummer aus dem Stacktrace.
     * 
     * Sucht nach dem ersten Stack Frame der zur Testklasse gehört.
     * Format: at com.automotive.sample.SensorDataProcessorTest.methodName(SensorDataProcessorTest.kt:36)
     * 
     * Paradigma: Regex als Mini-Parser – in C++ würdest du
     * string::find und substr nutzen. Regex ist hier präziser
     * und lesbarer für strukturierte Textmuster.
     */
    private extractLineNumber(
        stackTrace: string,
        className: string
    ): { fileName: string; lineNumber: number } | null {
        // Einfachen Klassennamen aus fully qualified Name extrahieren
        const simpleClassName = className.split('.').pop() ?? className;

        // Regex sucht nach: (ClassName.kt:Zeilennummer)
        const pattern = new RegExp(
            `at[^(]+${simpleClassName}\\.([^(]+)\\(${simpleClassName}\\.kt:(\\d+)\\)`
        );
        const match = stackTrace.match(pattern);

        if (match) {
            return {
                fileName: `${simpleClassName}.kt`,
                lineNumber: parseInt(match[2], 10) - 1 // VSCode ist 0-basiert
            };
        }

        return null;
    }
}