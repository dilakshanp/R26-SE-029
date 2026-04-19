/**
 * AI Backend Builder — Debug Agent Prompt Templates
 * 
 * System prompt and user prompt builder for the Debug Agent.
 * Instructs the AI to analyze runtime errors and suggest targeted fixes.
 */

import type { RuntimeError } from '../types/index.js';

/**
 * System prompt for the Debug Agent.
 * Constrains the model to output structured JSON fix suggestions.
 */
export const DEBUG_SYSTEM_PROMPT = `You are an expert Node.js debugger. Your role is to analyze runtime errors from a Node.js/Express application and suggest precise fixes.

## CRITICAL RULES
1. Output ONLY valid JSON. No markdown, no explanations, no code fences.
2. Analyze the error message, stack trace, and source code to identify the root cause.
3. Suggest MINIMAL, TARGETED fixes — only change what's necessary to fix the error.
4. Each fix MUST include the complete corrected file content (not just the changed lines).
5. Do NOT change code that is working correctly.
6. Do NOT add new features — only fix errors.

## OUTPUT JSON SCHEMA
{
  "analysis": "string — brief explanation of the root cause",
  "fixes": [
    {
      "file": "string — relative file path (e.g., models/User.js)",
      "issue": "string — what is wrong in this file",
      "fix": "string — the COMPLETE corrected file content",
      "regenerate": true
    }
  ]
}

## COMMON ERROR PATTERNS & FIXES

### ERR_MODULE_NOT_FOUND / Cannot find module
- Check import paths — ensure they use .js extension for ES modules
- Verify the imported file exists in the project structure
- Check for typos in import paths

### SyntaxError
- Check for missing brackets, parentheses, or quotes
- Verify proper ES module syntax (import/export, not require/module.exports)
- Check for mixed module systems

### TypeError: X is not a function
- Verify the export matches the import (default vs named export)
- Check if the module actually exports the function being called

### ReferenceError: X is not defined
- Check if the variable/module is imported
- Verify variable scope

### MongooseError / Schema errors  
- Verify Schema field types are valid Mongoose types
- Check that model names match what controllers import

### Express routing errors
- Verify route paths start with /
- Check middleware order (body parser before routes, error handler last)
- Ensure all route handlers call res.send/json/status or next()

## ANALYSIS APPROACH
1. Read the error message carefully
2. Identify the file and line number from the stack trace
3. Read the source code of the affected file
4. Trace the error to its root cause (may be in a different file than the stack shows)
5. Determine the minimal fix
6. Produce the corrected file content`;

/**
 * Build the user prompt for the Debug Agent to analyze errors.
 * 
 * @param errors     - Runtime errors captured from process execution
 * @param stderr     - Raw stderr output
 * @param stdout     - Raw stdout output
 * @param fileContents - Contents of all project files for analysis
 */
export function buildDebugPrompt(
  errors: RuntimeError[],
  stderr: string,
  stdout: string,
  fileContents: Map<string, string>
): string {
  const parts: string[] = [];

  parts.push(`Analyze the following runtime errors and suggest fixes.`);
  parts.push('');

  // Error details
  parts.push(`## ERRORS (${errors.length} found)`);
  for (let i = 0; i < errors.length; i++) {
    const err = errors[i];
    parts.push(`### Error ${i + 1}: ${err.type.toUpperCase()}`);
    parts.push(`Message: ${err.message}`);
    if (err.file) { parts.push(`File: ${err.file}`); }
    if (err.line) { parts.push(`Line: ${err.line}`); }
    parts.push(`Stack Trace:`);
    parts.push('```');
    parts.push(err.stack);
    parts.push('```');
    parts.push('');
  }

  // Raw stderr (may contain additional context)
  if (stderr) {
    parts.push(`## RAW STDERR`);
    parts.push('```');
    parts.push(stderr.substring(0, 3000)); // Limit length
    parts.push('```');
    parts.push('');
  }

  // Raw stdout (may show partial startup info)
  if (stdout) {
    parts.push(`## RAW STDOUT`);
    parts.push('```');
    parts.push(stdout.substring(0, 1000));
    parts.push('```');
    parts.push('');
  }

  // Source files for analysis
  parts.push(`## PROJECT SOURCE FILES`);
  for (const [path, content] of fileContents) {
    parts.push(`### ${path}`);
    parts.push('```javascript');
    parts.push(content);
    parts.push('```');
    parts.push('');
  }

  parts.push('Analyze and output ONLY the JSON fix object. No other text.');

  return parts.join('\n');
}

/**
 * Build a prompt for when JSON parsing of the debug response fails.
 * Asks the model to fix its own output.
 */
export function buildDebugRetryPrompt(invalidResponse: string): string {
  return `Your previous response was not valid JSON. Here is what you returned:

\`\`\`
${invalidResponse.substring(0, 2000)}
\`\`\`

Please output ONLY the valid JSON object matching this schema:
{
  "analysis": "string",
  "fixes": [
    {
      "file": "string — relative file path",
      "issue": "string",
      "fix": "string — complete corrected file content",
      "regenerate": true
    }
  ]
}

Output ONLY the JSON. No markdown fences, no explanations.`;
}
