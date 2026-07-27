# Prompt injection handling

Application questions, help text, job descriptions, company text, resume text, approved answers,
and user-added evidence are untrusted data. They never become system instructions.

The server:

- detects common override, secret-exfiltration, tool-use, HTML/script, and instruction-smuggling
  patterns before generation and surfaces warnings;
- places untrusted content inside explicit data delimiters;
- tells the model to use only numbered evidence and ignore instructions found inside it;
- sends no raw HTML, cookies, credentials, DOM selectors, file paths, or document bytes;
- requests a closed JSON schema with answer text, evidence IDs, factual claims, missing facts,
  warnings, confidence, and counts;
- discards unknown keys and rejects unknown evidence IDs, tool/code output, placeholders,
  unsupported claims, and limit violations;
- never executes model output.

Detection is defense in depth, not proof that text is safe. A warning does not become an
instruction. If validation cannot prove the answer is grounded, the draft remains blocked or asks
for user input. The user must review and explicitly approve every generated answer.
