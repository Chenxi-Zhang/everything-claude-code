#!/usr/bin/env node
/**
 * golang-tab-hook.js — Bidirectional ^I encode/decode hook for Claude Code
 *
 * PostToolUse/Read:  Encode leading tabs as ^I tokens in Read output,
 *                     so the AI can see indentation clearly.
 * PreToolUse/Edit:   Decode ^I tokens back to real tab characters in
 *                     old_string / new_string before Edit executes.
 *
 * Hook event is determined by the `hook_event_name` field in stdin JSON:
 *   - "PostToolUse" → encode mode
 *   - "PreToolUse"  → decode mode
 *
 * Exit codes:
 *   0 = success (stdout may contain JSON override)
 *   2 = block with stderr feedback
 */

"use strict";

const fs = require("fs");

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Read all stdin as a string (handles chunked/piped input).
 */
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(chunks.join("")));
    process.stdin.on("error", reject);
  });
}

/**
 * Encode leading tabs in a line as ^I tokens.
 * Only leading whitespace tabs are encoded (not mid-line tabs).
 *
 * "  \t\tfunc foo()" → "  ^I^Ifunc foo()"
 */
function encodeLeadingTabs(line) {
  let i = 0;
  while (i < line.length && (line[i] === " " || line[i] === "\t")) {
    i++;
  }
  const leading = line.slice(0, i);
  const rest = line.slice(i);
  const encoded = leading.replace(/\t/g, "^I");
  return encoded + rest;
}

/**
 * Decode leading ^I tokens back to real tab characters, per line.
 * Only leading whitespace ^I is converted; mid-line ^I is preserved.
 *
 * "  ^I^Ifunc ^Ifoo()" → "  \t\tfunc ^Ifoo()"
 */
function decodeCaretI(str) {
  return str.split("\n").map(line => {
    let i = 0;
    while (i < line.length) {
      if (line[i] === " ") {
        i++;
      } else if (line.substring(i, i + 2) === "^I") {
        i += 2;
      } else {
        break;
      }
    }
    const leading = line.slice(0, i);
    const rest = line.slice(i);
    return leading.replace(/\^I/g, "\t") + rest;
  }).join("\n");
}

/**
 * Check if a file path looks like a tab-indented source file.
 * We primarily target .go files but can extend this list.
 */
function isTabFile(filePath) {
  if (!filePath) return false;
  return /\.(go|mod|sum|proto)$/i.test(filePath);
}

// ── PostToolUse/Read: Encode ────────────────────────────────────────

/**
 * After Read returns file content, encode leading tabs as ^I.
 * The AI then sees clear indentation markers and can write Edit
 * old_string / new_string using ^I tokens instead of guessing tabs.
 *
 * Input JSON fields used:
 *   tool_response.content  — the file content returned by Read
 *   tool_input.file_path   — used to check file type
 *
 * Output: prints JSON with hookSpecificOutput.additionalContext
 *   containing the encoded content as a hint.
 */
function handlePostToolUse(input) {
  const filePath = input.tool_input?.file_path || "";
  if (!isTabFile(filePath)) {
    // Not a tab-indented file — pass through
    process.exit(0);
  }

  const content = input.tool_response?.file?.content || input.tool_response?.content;
  if (!content || typeof content !== "string") {
    process.exit(0);
  }

  const lines = content.split("\n");
  let hadTabs = false;

  const encoded = lines.map((line) => {
    if (line.includes("\t")) {
      hadTabs = true;
      return encodeLeadingTabs(line);
    }
    return line;
  });

  if (!hadTabs) {
    // No tabs found — nothing to encode
    process.exit(0);
  }

  // Return the encoded content as additional context so the AI sees ^I markers
  const output = {
    hookSpecificOutput: {
      additionalContext:
        "[tab-hook] This file uses tab indentation. Use ^I in Edit old_string/new_string.\n"
    },
  };

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// ── PreToolUse/Edit: Decode ─────────────────────────────────────────

/**
 * Before Edit executes, decode any ^I tokens in old_string and new_string
 * back to real tab characters.
 *
 * Input JSON fields used:
 *   tool_input.file_path   — used to check file type
 *   tool_input.old_string  — may contain ^I tokens
 *   tool_input.new_string  — may contain ^I tokens
 *
 * Output: prints JSON with updatedInput containing decoded strings,
 *   or exits 0 with no output if no changes needed.
 */
function handlePreToolUse(input) {
  const filePath = input.tool_input?.file_path || "";
  const oldStr = input.tool_input?.old_string || "";
  const newStr = input.tool_input?.new_string || "";

  // Check if file is tab-indented OR if the strings contain ^I tokens
  const hasCaretI = oldStr.includes("^I") || newStr.includes("^I");
  if (!isTabFile(filePath) && !hasCaretI) {
    // Not applicable — pass through
    process.exit(0);
  }

  if (!hasCaretI) {
    // File is tab-indented but no ^I tokens used — pass through
    process.exit(0);
  }

  // Decode ^I → \t
  const decodedOld = decodeCaretI(oldStr);
  const decodedNew = decodeCaretI(newStr);

  if (decodedOld === oldStr && decodedNew === newStr) {
    // Nothing actually changed (shouldn't happen if hasCaretI, but safety check)
    process.exit(0);
  }

  // Build updated input with decoded strings
  const updatedInput = {
    ...input.tool_input,
    old_string: decodedOld,
    new_string: decodedNew,
  };

  const output = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      updatedInput,
    },
  };

  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  let input;
  try {
    const raw = await readStdin();
    if (!raw.trim()) {
      process.exit(0);
    }
    input = JSON.parse(raw);
  } catch (e) {
    // Malformed input — let the tool proceed normally
    process.exit(0);
  }

  const event = input.hook_event_name;

  if (event === "PostToolUse") {
    handlePostToolUse(input);
  } else if (event === "PreToolUse") {
    handlePreToolUse(input);
  } else {
    // Unknown event — pass through
    process.exit(0);
  }
}

main().catch(() => process.exit(0));
