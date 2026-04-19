/**
 * AI Backend Builder — Code Generator Agent Prompt Templates
 * 
 * System prompt and user prompt builder for the Code Generator Agent.
 * Instructs the AI to produce clean, modular, production-ready Express.js code.
 */

import type { Entity, Feature, FileSpec } from '../types/index.js';
import { MAX_CONTEXT_LENGTH } from '../utils/constants.js';

/**
 * System prompt for the Code Generator Agent.
 * Constrains the model to output ONLY source code.
 */
export const CODEGEN_SYSTEM_PROMPT = `You are an expert Node.js/Express.js backend developer. Your role is to generate production-ready, clean, modular code files.

## CRITICAL RULES
1. Output ONLY the file's source code. No markdown code fences, no explanations before or after.
2. Use ES6 Modules (import/export). Do NOT use require/module.exports.
3. Use async/await for all asynchronous operations. No raw promises or callbacks.
4. Follow MVC architecture strictly.
5. Include meaningful inline comments explaining complex logic.
6. Handle all errors with try/catch and pass errors to Express error middleware via next(error).
7. Use destructuring, template literals, and modern JavaScript features.
8. Every file MUST be complete and self-contained — no TODO placeholders or incomplete code.

## TECHNOLOGY REQUIREMENTS
- Express.js for routing and middleware
- Mongoose for MongoDB models (use Schema, model)
- dotenv for environment variables (import 'dotenv/config' in app.js only)
- bcryptjs for password hashing
- jsonwebtoken for JWT authentication
- express-validator for input validation (when applicable)

## CODE STYLE
- Use 2-space indentation
- Use single quotes for strings
- Add JSDoc comments for exported functions
- Use descriptive variable and function names
- Group imports: built-in → third-party → local modules
- Export at the end of the file or use named exports

## FILE-SPECIFIC GUIDELINES

### Models (models/*.js)
- Import mongoose, define Schema with validators
- Add timestamps: true to schema options
- Export the model as default

### Controllers (controllers/*.js)
- Import the relevant model
- Export named async functions: getAll, getById, create, update, delete
- Use req.params, req.body, req.query appropriately
- Return proper HTTP status codes (200, 201, 400, 404, 500)
- Use try/catch with next(error) for error handling

### Routes (routes/*.js)
- Import express Router
- Import controller functions
- Import auth middleware if authentication is required
- Define RESTful routes: GET /, GET /:id, POST /, PUT /:id, DELETE /:id
- Export the router as default

### Middleware (middleware/*.js)
- Export named functions
- Authentication: verify JWT from Authorization header (Bearer token)
- Error handler: catch-all (err, req, res, next) with proper error response

### Config (config/*.js)
- Database: connect to MongoDB using mongoose.connect() with MONGODB_URI from env
- Export the connection function

### App Entry (app.js)
- Import dotenv/config first
- Import express, cors, helmet (if available)
- Import database connection
- Import all route files
- Set up middleware: json parser, cors, etc.
- Mount routes with versioned paths (/api/...)
- Add error handling middleware LAST
- Start server on PORT from env
- Log "Server running on port..." message`;

/**
 * Build the user prompt for generating a specific file.
 * Includes full project context so the generator understands
 * the overall architecture and can reference other files.
 * 
 * @param fileSpec          - The file to generate (path + description)
 * @param projectName       - The project name
 * @param entities          - All entities in the project
 * @param features          - All features in the project
 * @param allFiles          - All files in the plan (for cross-reference)
 * @param existingContents  - Contents of already-generated files
 * @param existingFileContent - Current content if updating an existing file
 */
export function buildCodeGenPrompt(
  fileSpec: FileSpec,
  projectName: string,
  entities: Entity[],
  features: Feature[],
  allFiles: FileSpec[],
  existingContents: Map<string, string>,
  existingFileContent?: string
): string {
  const parts: string[] = [];

  // Header
  parts.push(`Generate the complete source code for the following file.`);
  parts.push('');

  // Target file info
  parts.push(`## TARGET FILE`);
  parts.push(`- Path: ${fileSpec.path}`);
  parts.push(`- Description: ${fileSpec.description}`);
  parts.push('');

  // Project context
  parts.push(`## PROJECT: ${projectName}`);
  parts.push('');

  // Entities
  if (entities.length > 0) {
    parts.push(`## ENTITIES`);
    for (const entity of entities) {
      parts.push(`### ${entity.name}`);
      if (entity.description) {
        parts.push(`Description: ${entity.description}`);
      }
      parts.push('Fields:');
      for (const field of entity.fields) {
        const modifiers: string[] = [];
        if (field.required) { modifiers.push('required'); }
        if (field.unique) { modifiers.push('unique'); }
        const modStr = modifiers.length > 0 ? ` (${modifiers.join(', ')})` : '';
        parts.push(`  - ${field.name}: ${field.type}${modStr}`);
      }
      parts.push('');
    }
  }

  // Features
  if (features.length > 0) {
    parts.push(`## FEATURES`);
    for (const feature of features) {
      parts.push(`- ${feature.name}: ${feature.description}`);
    }
    parts.push('');
  }

  // Project file list (for import path awareness)
  parts.push(`## ALL PROJECT FILES`);
  for (const f of allFiles) {
    const marker = f.path === fileSpec.path ? ' ← (THIS FILE)' : '';
    parts.push(`- ${f.path}: ${f.description}${marker}`);
  }
  parts.push('');

  // Include contents of related files for context (truncated to fit token limits)
  const relatedFiles = getRelatedFiles(fileSpec.path, allFiles, existingContents);
  if (relatedFiles.length > 0) {
    parts.push(`## ALREADY GENERATED FILES (for reference)`);
    let contextLength = 0;
    for (const [path, content] of relatedFiles) {
      if (contextLength + content.length > MAX_CONTEXT_LENGTH) {
        parts.push(`\n(... remaining files omitted for brevity)`);
        break;
      }
      parts.push(`\n### ${path}`);
      parts.push('```javascript');
      parts.push(content);
      parts.push('```');
      contextLength += content.length;
    }
    parts.push('');
  }

  // If updating an existing file
  if (existingFileContent) {
    parts.push(`## CURRENT FILE CONTENT (update this file)`);
    parts.push('```javascript');
    parts.push(existingFileContent);
    parts.push('```');
    parts.push('');
    parts.push('Update the above file to incorporate the project requirements. Preserve existing functionality while adding new features.');
  }

  parts.push('');
  parts.push('Output ONLY the complete source code. No markdown fences, no explanations.');

  return parts.join('\n');
}

/**
 * Determine which existing files are most relevant to the file being generated.
 * Models are relevant to controllers, controllers to routes, config to app.js, etc.
 */
function getRelatedFiles(
  targetPath: string,
  allFiles: FileSpec[],
  existingContents: Map<string, string>
): Array<[string, string]> {
  const related: Array<[string, string]> = [];

  // Determine what kind of file we're generating
  const isModel = targetPath.startsWith('models/');
  const isController = targetPath.startsWith('controllers/');
  const isRoute = targetPath.startsWith('routes/');
  const isApp = targetPath === 'app.js';
  const isMiddleware = targetPath.startsWith('middleware/');

  for (const [path, content] of existingContents) {
    // Don't include the file itself
    if (path === targetPath) { continue; }

    let isRelevant = false;

    // Controllers need to see their corresponding model
    if (isController && path.startsWith('models/')) { isRelevant = true; }

    // Routes need to see their corresponding controller and middleware
    if (isRoute && (path.startsWith('controllers/') || path.startsWith('middleware/'))) {
      isRelevant = true;
    }

    // app.js needs to see routes and config
    if (isApp && (path.startsWith('routes/') || path.startsWith('config/') || path.startsWith('middleware/'))) {
      isRelevant = true;
    }

    // Middleware might need to see models (e.g., auth middleware looking up users)
    if (isMiddleware && path.startsWith('models/')) { isRelevant = true; }

    // Config is relevant to app.js
    if (isApp && path.startsWith('config/')) { isRelevant = true; }

    if (isRelevant) {
      related.push([path, content]);
    }
  }

  return related;
}
