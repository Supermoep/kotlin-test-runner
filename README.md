# Kotlin Test Runner

A Visual Studio Code extension that integrates Kotlin test execution directly into VS Code's native Testing UI via Gradle.

## Features

- **Automatic test discovery** — Scans `src/test/kotlin/` for classes with `@Test`-annotated methods and registers them in the VS Code Testing panel.
- **Run tests from the UI** — Execute individual test methods, entire test classes, or all tests directly from the Testing panel without leaving the editor.
- **Inline failure reporting** — Failed tests show error messages and stack traces inline in the editor, with navigation to the exact failing line.
- **`@DisplayName` support** — Tests annotated with `@DisplayName` display their human-readable label in the Testing panel instead of the raw method name.
- **Live file watching** — The test tree updates automatically whenever a `.kt` file is created, changed, or deleted.
- **Gradle wrapper support** — Prefers `./gradlew` over a globally installed `gradle` binary.

## Requirements

- **VS Code** `1.109.0` or later
- **JDK** installed and available on `PATH`
- A **Gradle-based Kotlin project** with tests located under `src/test/kotlin/`
- Either a `gradlew` wrapper in the project root or `gradle` available on `PATH`

The project must follow the standard Maven/Gradle source layout:

```
<project-root>/
└── src/
    └── test/
        └── kotlin/
            └── com/example/
                └── MyTest.kt
```

## How to Use

1. Open the root folder of your Kotlin/Gradle project in VS Code.
2. The extension activates automatically when it detects `.kt` files in the workspace.
3. Open the **Testing** panel (beaker icon in the activity bar).
4. The test tree is populated with all discovered test classes and methods.
5. Click the run button next to any test, class, or the root node to execute tests.

### Example Test Class

```kotlin
package com.example

import org.junit.jupiter.api.Test
import org.junit.jupiter.api.DisplayName

class CalculatorTest {

    @Test
    @DisplayName("should add two numbers")
    fun add() {
        // ...
    }

    @Test
    fun `subtract two numbers`() {
        // ...
    }
}
```

## Extension Settings

This extension contributes the following settings, configurable in VS Code's Settings UI or `settings.json`:

### `kotlinTestRunner.testSourceSets`

An array of named test source directories to scan for `@Test`-annotated methods.
Each entry has two required fields:

| Field | Type | Description |
|---|---|---|
| `name` | `string` | Label shown in the Test Explorer (used as a group node when multiple sets exist). |
| `path` | `string` | Path to the source directory, relative to the workspace root. |

**Default:**
```json
"kotlinTestRunner.testSourceSets": [
  { "name": "Tests", "path": "src/test/kotlin" }
]
```

**Multi-source-set example:**
```json
"kotlinTestRunner.testSourceSets": [
  { "name": "Unit Tests",        "path": "src/test/kotlin" },
  { "name": "Integration Tests", "path": "src/integrationTest/kotlin" }
]
```

With multiple source sets the Test Explorer tree gains an extra grouping level:

```
Kotlin Test Runner
├── Unit Tests
│   └── com.example.CalculatorTest
│       └── should add two numbers
└── Integration Tests
    └── com.example.IntegrationTest
        └── should run end to end
```

With a single source set the group node is omitted and classes appear at the root (flat tree).

The test tree automatically reloads when this setting is changed in VS Code settings — no window reload is required.

## Known Issues

- Test discovery is regex-based. Heavily macro-generated or annotation-processor-generated test methods may not be detected.

## Release Notes

### 0.0.1

Initial release with:
- Kotlin test discovery via regex parsing
- Gradle test execution with `--rerun` flag
- JUnit XML result parsing
- Inline failure locations in the editor
- `@DisplayName` support
- File system watcher for automatic test tree refresh
