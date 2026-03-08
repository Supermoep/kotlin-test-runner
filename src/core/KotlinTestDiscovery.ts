import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface TestMethod {
    name: string;           // Kotlin Funktionsname (Backtick)
    displayName: string;    // @DisplayName oder Funktionsname
    line: number;
}

export interface TestClass {
    name: string;
    packageName: string;
    fullyQualifiedName: string;
    filePath: string;
    methods: TestMethod[];
}

export class KotlinTestDiscovery {

    // Regex Patterns für Kotlin Test Erkennung
    private static readonly TEST_ANNOTATION = /@Test/;
    private static readonly DISPLAY_NAME_ANNOTATION = /@DisplayName\("(.+)"\)/;
    private static readonly CLASS_PATTERN = /^class\s+(\w+)/m;
    private static readonly PACKAGE_PATTERN = /^package\s+([\w.]+)/m;
    private static readonly FUN_PATTERN = /fun\s+`?([^`(]+)`?\s*\(/;

    /**
     * Scannt den gesamten Workspace nach Kotlin Testdateien.
     * 
     * Paradigma: Asynchrone Programmierung mit async/await.
     * In C++ würdest du synchron iterieren - hier geben wir
     * die Kontrolle zurück während wir auf IO warten.
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
     * Findet alle Kotlin Dateien im test Sourceset.
     */
    private async findKotlinTestFiles(workspaceRoot: string): Promise<string[]> {
        const testSourceDir = path.join(workspaceRoot, 'src', 'test', 'kotlin');

        if (!fs.existsSync(testSourceDir)) {
            vscode.window.showWarningMessage(
                `Kein Test-Verzeichnis gefunden: ${testSourceDir}`
            );
            return [];
        }

        return this.walkDirectory(testSourceDir, '.kt');
    }

    /**
     * Rekursives Durchsuchen eines Verzeichnisses.
     * Paradigma: Rekursion statt Iteration - in funktionalen Sprachen
     * ist das der bevorzugte Ansatz für Baumstrukturen.
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
     * Parst eine Kotlin Datei und extrahiert Testklassen und Methoden.
     */
    async parseKotlinFile(filePath: string): Promise<TestClass | null> {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');

        // Package und Klassenname extrahieren
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

        // Testmethoden extrahieren
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
     * Extrahiert alle mit @Test annotierten Methoden.
     */
    private extractTestMethods(lines: string[]): TestMethod[] {
        const methods: TestMethod[] = [];
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];

            if (KotlinTestDiscovery.TEST_ANNOTATION.test(line)) {
                // DisplayName aus nächster oder übernächster Zeile suchen
                let displayName = '';
                const displayNameMatch = lines[i - 1]?.match(
                    KotlinTestDiscovery.DISPLAY_NAME_ANNOTATION
                );
                if (displayNameMatch) {
                    displayName = displayNameMatch[1];
                }

                // Funktionsname in den nächsten 3 Zeilen suchen
                for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                    const funMatch = lines[j].match(KotlinTestDiscovery.FUN_PATTERN);
                    if (funMatch) {
                        methods.push({
                            name: funMatch[1].trim(),
                            line: j,
                            displayName: displayName || funMatch[1].trim()
                        });
                        break;
                    }
                }
            }
        }

        return methods;
    }
}