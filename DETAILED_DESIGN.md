# Kotlin Test Runner — Detailed Design

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Component Descriptions](#component-descriptions)
   - [extension.ts](#extensionts)
   - [KotlinTestDiscovery](#kotlintestdiscovery)
   - [GradleBridge](#gradlebridge)
   - [ResultParser](#resultparser)
4. [Data Model](#data-model)
5. [End-to-End Data Flow](#end-to-end-data-flow)
6. [Key Design Decisions](#key-design-decisions)
7. [Known Limitations](#known-limitations)

---

## Overview

The extension is a VS Code **Testing API** integration. It bridges three concerns that VS Code itself does not connect automatically:

| Concern | Implemented by |
|---|---|
| Discovering which tests exist | `KotlinTestDiscovery` |
| Running them via the build tool | `GradleBridge` |
| Interpreting the results | `ResultParser` |

`extension.ts` wires these three components together and manages the VS Code `TestController` lifecycle.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                      VS Code Host                        │
│                                                          │
│  Testing Panel ◄──── TestController ◄──── extension.ts  │
│                            │                             │
│  FileSystemWatcher ────────┘                             │
└────────────────────────────┬────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
              ▼              ▼              ▼
   KotlinTestDiscovery  GradleBridge  ResultParser
              │              │              │
              ▼              ▼              ▼
        .kt files      ./gradlew        TEST-*.xml
  (configured paths)  (child_process)  (build/test-results/test)
```

The three core components have **no dependency on each other** — they are all independently instantiated and composed exclusively in `extension.ts`. This makes them independently testable.

---

## Component Descriptions

### `extension.ts`

**Role:** Extension lifecycle manager and orchestrator.

**Responsibilities:**
- Register the `TestController` with VS Code.
- Trigger initial test discovery on activation.
- Set up a `FileSystemWatcher` to re-discover tests when `.kt` files change.
- Listen for `onDidChangeConfiguration` to reload the test tree when source set settings change.
- Register the `Run` test profile which defines what happens when the user clicks a run button.
- Translate between VS Code's `TestItem` model and the Gradle filter syntax.

**Key functions:**

| Function | Description |
|---|---|
| `activate(context)` | Extension entry point. Initialises all components, loads tests, registers run handler. |
| `getSourceSets()` | Reads `kotlinTestRunner.testSourceSets` from VS Code settings; applies the built-in default when the setting is absent or empty. |
| `loadTests(controller, discovery, workspaceRoot, sourceSets)` | Clears the current item tree and rebuilds it. Adds a source-set group layer when 2+ sets are configured. |
| `buildClassItem(controller, testClass)` | Creates a parent `TestItem` for a test class with all method children attached. |
| `collectTests(request, controller)` | Recursively traverses the `TestItem` tree and returns a flat map of `TestItem → gradleFilter`. |
| `groupTestsByClass(testsToRun)` | Groups the flat map by fully-qualified class name for batch Gradle execution. |

**Result matching logic:**

After Gradle finishes and the XML is parsed, results are matched to `TestItem`s by their `.id` property:

```
TestItem.id  ──►  exact lookup in result Map
                  │
                  └── not found ──►  case-insensitive lookup
                                     │
                                     └── not found ──►  use Gradle exit code as fallback
```

---

### `KotlinTestDiscovery`

**Role:** Static analysis of Kotlin source files to discover test classes and methods.

**Source directories:** Determined by the `kotlinTestRunner.testSourceSets` setting. Each entry provides a name and a path relative to the workspace root. The discovery class receives a resolved `SourceSetConfig[]` from `extension.ts` and scans each configured directory independently.

**Parsing strategy:** Pure regex-based line scanning — no Kotlin parser or compiler is invoked. This is fast and requires no additional tooling, but is limited to statically detectable patterns.

**Key regex patterns:**

| Pattern | Purpose |
|---|---|
| `/@Test/` | Detect a test annotation on a line |
| `/@DisplayName\("(.+)"\)/` | Extract the human-readable test name |
| `/^class\s+(\w+)/m` | Extract the class name |
| `/^package\s+([\w.]+)/m` | Extract the package declaration |
| `/fun\s+\`?([^\`(]+)\`?\s*\(/` | Extract the function name (handles backtick-quoted names) |

**`@DisplayName` search window:**

When a `@Test` is found at line `i`, the discovery looks for `@DisplayName` in the range `[i-3, i-1]` (before) and `[i+1, i+3]` (after). This accommodates all common orderings:

```kotlin
// Before (common):
@DisplayName("my test")
@Test
fun myTest() {}

// After (less common but supported):
@Test
@DisplayName("my test")
fun myTest() {}
```

**`fun` declaration search:** Searches lines `[i+1, i+4]` after `@Test` for the function declaration, allowing for annotations between `@Test` and `fun`.

**Interfaces:**

```typescript
interface SourceSetConfig {
    name: string;  // Label shown in Test Explorer
    path: string;  // Relative path from workspace root (e.g. "src/test/kotlin")
}

interface TestMethod {
    name: string;         // Raw Kotlin function name (used for Gradle filter)
    displayName: string;  // @DisplayName value, or falls back to name
    hasDisplayName: boolean;
    line: number;         // 0-based line number of the fun declaration
}

interface TestClass {
    name: string;               // Simple class name
    packageName: string;
    fullyQualifiedName: string; // e.g. "com.example.CalculatorTest"
    filePath: string;
    methods: TestMethod[];
    sourceSetName: string;      // Name of the source set this class was found in
}
```

---

### `GradleBridge`

**Role:** Execute Gradle commands in the workspace and capture output.

**Execution:** Uses Node.js `child_process.exec` with the workspace root as the working directory and inherits the full shell environment (`process.env`).

**Cancellation:** All public execution methods accept an optional `vscode.CancellationToken`. When the token fires (user clicks the stop button), the spawned child process is killed immediately via `childProcess.kill()`. The promise resolves with `{ success: false, cancelled: true }` and any in-progress test items are marked as `skipped` by the run handler in `extension.ts`.

**Gradle command selection:**

```
{workspaceRoot}/gradlew exists?
        │
       YES ──► ./gradlew
        │
        NO  ──► gradle   (must be on PATH)
```

**Test filter format:**

Single test:
```
./gradlew test --rerun --tests "com.example.CalculatorTest.add"
```

Multiple tests (batched by class in `extension.ts`):
```
./gradlew test --rerun --tests "com.example.CalculatorTest.add" --tests "com.example.CalculatorTest.subtract"
```

All tests:
```
./gradlew cleanTest test
```

The `--rerun` flag forces Gradle to re-execute the task even if its inputs have not changed (Gradle's up-to-date check would otherwise skip tests that passed previously).

**Output channel:** All command output (stdout + stderr) is appended to a dedicated VS Code `OutputChannel` named `"Kotlin Test Runner"`.

**Result path:** Always resolves to `{workspaceRoot}/build/test-results/test`. This is the standard Gradle JUnit XML output directory for the default `test` task.

**Interface:**

```typescript
interface GradleTestResult {
    success: boolean;       // true when Gradle exits with code 0
    output: string;         // captured stdout
    xmlResultsPath: string; // absolute path to the XML results directory
    cancelled?: boolean;    // true when the run was stopped by the user
}
```

---

### `ResultParser`

**Role:** Parse JUnit XML test result files produced by Gradle into a structured map.

**Input:** A directory containing `TEST-*.xml` files in JUnit format (as produced by Gradle's `test` task).

**Output:** `Map<string, TestResult>` — keyed by fully-qualified test name in the form `"com.example.CalculatorTest.myTestMethod"`.

**XML structure consumed:**

```xml
<testsuite>
  <testcase classname="com.example.CalculatorTest" name="add()" time="0.012">
    <!-- passing: no child elements -->
  </testcase>
  <testcase classname="com.example.CalculatorTest" name="subtract()" time="0.005">
    <failure message="expected: 3 but was: 2">
      ...stack trace...
    </failure>
  </testcase>
</testsuite>
```

**Method name normalisation:** Gradle appends `()` to method names when there is no `@DisplayName`. The parser strips this suffix to produce a name that matches the VS Code `TestItem.id` format.

**Failure location extraction:**

Parses the Java stack trace looking for a frame matching the test class:

```
at com.example.CalculatorTest.subtract(CalculatorTest.kt:25)
                                                              ^^
                                                          line 25 (1-indexed)
                                                          → stored as 24 (0-indexed)
```

The regex pattern used:

```
at[^(]+SimpleClassName\.([^(]+)\(SimpleClassName\.kt:(\d+)\)
```

**Interface:**

```typescript
interface TestResult {
    passed: boolean;
    failed: boolean;
    skipped: boolean;
    duration?: number;          // milliseconds
    errorMessage?: string;      // failure/@message attribute
    errorStackTrace?: string;   // failure element text content
    failureLineNumber?: number; // 0-based line extracted from stack trace
    failureFile?: string;       // e.g. "CalculatorTest.kt"
}
```

---

## Data Model

### TestItem tree structure in VS Code

**Single source set (flat — source set group node is omitted):**

```
TestController.items
└── TestItem (id = "com.example.CalculatorTest", label = "CalculatorTest")
    ├── TestItem
    │   id    = "com.example.CalculatorTest.should add two numbers"
    │   label = "should add two numbers"               ← @DisplayName value
    │   tags  = [Tag("gradle:com.example.CalculatorTest.add")]  ← raw method name
    │   range = Range(line 12, 0, line 12, 0)
    └── TestItem
        id    = "com.example.CalculatorTest.subtract two numbers"
        label = "subtract two numbers"                 ← backtick-quoted name
        tags  = [Tag("gradle:com.example.CalculatorTest.subtract two numbers")]
        range = Range(line 18, 0, line 18, 0)
```

**Multiple source sets (source set group nodes at root):**

```
TestController.items
├── TestItem (id = "source-set:Unit Tests", label = "Unit Tests")          ← group node
│   └── TestItem (id = "com.example.CalculatorTest", label = "CalculatorTest")
│       └── TestItem (id = "com.example.CalculatorTest.add", ...)
└── TestItem (id = "source-set:Integration Tests", label = "Integration Tests")  ← group node
    └── TestItem (id = "com.example.IntegrationTest", label = "IntegrationTest")
        └── TestItem (id = "com.example.IntegrationTest.should run end to end", ...)
```

Group nodes (`source-set:*`) carry no `gradle:` tags and always have children, so `collectTests` naturally traverses through them without treating them as executable tests.

**Key distinction:** Method `TestItem.id` uses the `displayName` for a stable, human-readable identity in the VS Code UI, while the `gradle:` tag stores the raw Kotlin function name required for the Gradle `--tests` filter.

### Naming convention table

| Source | Value | Usage |
|---|---|---|
| Kotlin source | `fun add()` | Base method name |
| `@DisplayName("should add")` | `should add` | VS Code label and TestItem id suffix |
| Gradle filter | `com.example.CalculatorTest.add` | `--tests` argument |
| XML `testcase/@name` | `add()` or `should add` | Parsed by `ResultParser` |
| ResultParser key | `com.example.CalculatorTest.add` | Lookup key in result map |

---

## End-to-End Data Flow

```
Extension Activation
        │
        ▼
getSourceSets()  — reads kotlinTestRunner.testSourceSets config
  └─► returns SourceSetConfig[]  (default: [{ name: "Tests", path: "src/test/kotlin" }])
        │
        ▼
KotlinTestDiscovery.discoverTests(workspaceRoot, sourceSets)
  └─► for each source set: scans {workspaceRoot}/{sourceSet.path}/**/*.kt
  └─► tags each TestClass with its sourceSetName
  └─► returns TestClass[]
        │
        ▼
loadTests() — builds VS Code TestItem tree
  ├─► single source set  →  flat: classes at controller root
  └─► multiple sets      →  grouped: source-set group node per set, classes as children
        │
        per class / per method:
        ├─► id    = FQN + "." + displayName
        ├─► tags  = ["gradle:FQN.methodName"]
        └─► range = method declaration line
        │
        ▼
User clicks "Run" in Testing panel
        │
        ▼
collectTests(request, controller)
  └─► recursively collects leaf TestItems (skips group nodes naturally)
  └─► returns Map<TestItem, gradleFilter>
        │
        ▼
groupTestsByClass(testsToRun)
  └─► groups by FQN class prefix
  └─► returns Map<className, [TestItem, filter][]>
        │
        ▼
For each class group:
  GradleBridge.runTests(filters[], token)
    └─► ./gradlew test --rerun --tests "..." ...
    └─► token.onCancellationRequested → childProcess.kill() → cancelled: true
    └─► returns GradleTestResult
        │
        ▼
  If cancelled: mark all items as skipped, skip remaining groups
        │
        ▼
  ResultParser.parseResults(xmlResultsPath)
    └─► reads build/test-results/test/TEST-*.xml
    └─► returns Map<FQN, TestResult>
        │
        ▼
  Match TestItem.id → TestResult
    ├─► exact match
    ├─► case-insensitive fallback
    └─► Gradle exit code fallback
        │
        ▼
  run.passed() / run.failed() / run.errored()
```

---

## Key Design Decisions

### Cancellation support
When the user clicks the stop button in the Testing panel, VS Code fires the `CancellationToken` passed to the run profile handler. The token is forwarded to `GradleBridge.executeGradle()`, which registers a `token.onCancellationRequested` listener. When the listener fires, the running Gradle child process is killed immediately (`childProcess.kill()`). The promise resolves with `cancelled: true` so the run handler can mark all in-progress test items as `skipped` and abort any remaining class groups.

### Separation of concerns
Discovery, execution, and result parsing are three independent classes with no direct dependencies. `extension.ts` is the only integration point.

### Regex-based discovery over compiler invocation
Invoking `kotlinc` or a language server for discovery would be slower, require additional setup, and complicate error handling. Regex parsing is instantaneous and dependency-free, at the cost of not handling generated or reflection-based tests.

### Display name / method name duality
The VS Code `TestItem.id` uses the human-readable `displayName` for a stable, readable identity in the UI. The actual Gradle filter (raw method name) is stored separately in a `gradle:` tag, because Gradle's `--tests` filter requires the exact Java/Kotlin method name — it does not understand `@DisplayName` values.

### Batch execution per class
All selected tests within the same class are submitted to Gradle in a single invocation. This is more efficient than one Gradle JVM startup per test method, as Gradle has significant startup overhead.

### `--rerun` flag
Gradle's incremental build would skip tests it considers up-to-date. The `--rerun` flag ensures the selected tests always execute, matching user expectations when clicking "Run" in the UI.

### File watching triggers full re-discovery
Any change to any `.kt` file causes a complete re-discovery pass. This is simple and correct, avoiding the need to detect which specific class was affected.

### Case-insensitive result matching
After the primary exact-match lookup of `TestItem.id` in the result map, a case-insensitive fallback is performed. This guards against potential casing discrepancies between the VS Code item id and the fully-qualified name as reported in the Gradle XML output.

### Configurable source sets with named grouping
Test source directories are declared in `kotlinTestRunner.testSourceSets`. Each entry carries a `name` (used for UI labelling) and a `path` (scanned directory). A built-in default (`src/test/kotlin`) ensures the extension works without any explicit configuration.

When two or more source sets are present, `loadTests` introduces an extra layer of group `TestItem`s (id prefix `source-set:`) at the controller root. With a single source set, this layer is omitted to keep the tree flat — consistent with how VS Code's built-in test runners behave. The decision of flat vs. grouped is made purely by comparing `sourceSets.length`, requiring no additional configuration.

### Configuration change listener
`vscode.workspace.onDidChangeConfiguration` is connected to `loadTests` so the test tree reflects setting changes immediately, without requiring the user to reload the VS Code window.

---

## Known Limitations

| Limitation | Impact |
|---|---|
| Regex-based parsing | Annotation-processor-generated tests or class/method names with complex formatting may not parse correctly |
| Single Gradle project | Multi-module Gradle projects are not supported; only the root module's tests are discovered and executed |
| XML results path is hardcoded | Only the default `test` task output is read; results from custom tasks or non-standard source sets are not accessible |
| No debug profile | Only a `Run` profile is registered; breakpoint debugging is not supported |
| No coverage profile | Running tests with coverage instrumentation is not supported |
| Empty extension test suite | `src/test/extension.test.ts` contains no tests for the extension itself |
