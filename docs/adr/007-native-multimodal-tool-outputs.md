# ADR-007 - SDK-native multimodal tool outputs

**Status:** Accepted

## Context

A file-loading tool must get image and document bytes into model context.

## Decision

Return `ToolOutputImage` for PNGs and rendered pages, and `ToolOutputFileContent` for PDFs
and GraphML. The SDK converts these into native Responses `input_image` and `input_file`
content.

No application `DocumentPayload` or `ImagePayload` is defined.

## Consequences

The model receives the artifact in the representation the provider defines, with `detail`
and `filename` carried through. A custom wrapper would have to be unwrapped somewhere, and
that somewhere would be a second place to keep in step with the provider content types.

`tests/unit/test_tools.py` asserts the returned types and that the encoded bytes match the
source file exactly.

## Reverses if

The SDK stops converting these types to native content.
