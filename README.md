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

This extension currently contributes no configuration settings.

## Known Issues

- Only the standard `src/test/kotlin/` source set is scanned. Custom test source sets are not yet supported.
- Test discovery is regex-based. Heavily macro-generated or annotation-processor-generated test methods may not be detected.
- The `kotlin-test-runner.helloWorld` command visible in the command palette is a leftover from the extension scaffold and has no effect.

## Release Notes

### 0.0.1

Initial release with:
- Kotlin test discovery via regex parsing
- Gradle test execution with `--rerun` flag
- JUnit XML result parsing
- Inline failure locations in the editor
- `@DisplayName` support
- File system watcher for automatic test tree refresh
