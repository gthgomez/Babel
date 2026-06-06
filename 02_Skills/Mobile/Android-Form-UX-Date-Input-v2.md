<!--
Babel - Prompt Operating System
Copyright (c) 2025-2026 Jonathan Gomez Aguilar
Licensed under the MIT License
-->

# Skill: Android Form UX and Date Input (v2.0)

**Category:** Mobile
**Status:** Active
**Pairs with:** `skill_jetpack_compose`, `skill_android_state_management`
**Activation:** Load for any add/edit form with dates, due dates, paydays, recurrence, or next occurrence fields.

**Supersedes:** v1 archived at `archive/02_Skills/Mobile/Android-Form-UX-Date-Input-v1.md` (2026-05-21).

## Purpose

Ensure the user explicitly chooses every schedule value that will be persisted and prevent silent default-date bugs.

## Core Rules

1. Model separate fields: `dueDate: LocalDate?`, `recurrenceRule: String?`, `nextOccurrence: LocalDate?` (derived). Do not collapse into one ambiguous field.
2. Default date is null unless product spec explicitly requires today. Never hardcode `LocalDate.now()` for business date fields.
3. Use Material 3 pickers. Create state with `rememberDatePickerState()`. For dialogs, wrap `DatePicker` in `DatePickerDialog`.
4. `initialSelectedDateMillis` is UTC milliseconds from epoch. Convert to local date before persisting: `Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault()).toLocalDate()`.
5. Material 3 `1.5.0-alpha04+` adds `rememberDatePickerState(initialSelectedDate: LocalDate?)`. Prefer it only when the project is already on a compatible alpha; otherwise keep the UTC-millis path for stable portability.
6. Hoist chosen millis or `LocalDate` to ViewModel on confirm. Keep `showPicker` boolean local.
7. Validate on blur and on save attempt. Show error via `isError` and `supportingText`. Disable save when required date is null.
8. Localization: format for display with locale-aware formatter; persist ISO date, not formatted string.
9. Accessibility: picker trigger must be `IconButton` with `contentDescription` (e.g., "Select due date"). IconButton provides minimum 48 x 48dp touch target.
10. Preview/edit consistency: edit screen must prefill picker with persisted value via `initialSelectedDateMillis` or the compatible `LocalDate` overload.

## Compose Example

```kotlin
var showPicker by remember { mutableStateOf(false) }
val dateState = rememberDatePickerState(initialSelectedDateMillis = ui.dueDateMillis)

OutlinedTextField(
    value = ui.dueDateText,
    onValueChange = {},
    readOnly = true,
    label = { Text("Due date") },
    trailingIcon = {
        IconButton(onClick = { showPicker = true }) {
            Icon(Icons.Default.DateRange, contentDescription = "Select due date")
        }
    },
    isError = ui.dateError != null,
    supportingText = { ui.dateError?.let { Text(it) } }
)

if (showPicker) {
    DatePickerDialog(
        onDismissRequest = { showPicker = false },
        confirmButton = {
            TextButton(onClick = {
                viewModel.onDateSelected(dateState.selectedDateMillis)
                showPicker = false
            }) { Text("OK") }
        }
    ) { DatePicker(state = dateState) }
}
```

## Hard Rules

1. Never save a date the user did not explicitly choose.
2. Never replace schedule inputs with generic frequency label alone.
3. Never store UI millis directly without timezone conversion.
4. Never hide validation; error must be visible before save.
