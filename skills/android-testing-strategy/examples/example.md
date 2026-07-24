# Example

User task:

```text
Add tests for this ViewModel and image processor.
```

Expected behavior:

- Check whether the ViewModel uses `mutableStateOf` or `StateFlow`.
- Put the ViewModel test in `src/test/`.
- Put Android framework image processing tests in `src/androidTest/`.
- If no device exists, run the compile gate and state connected execution was skipped.
