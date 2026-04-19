/**
 * AI Backend Builder — File Manager
 * 
 * Handles all file system operations using the VS Code workspace.fs API.
 * Respects the "do not overwrite blindly" constraint and provides
 * context-awareness by reading existing files before generation.
 */

import * as vscode from 'vscode';
import { Logger } from '../utils/logger.js';
import type { FileSpec, GeneratedFile } from '../types/index.js';

export class FileManager {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // File Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check if a file or directory exists at the given URI.
   */
  public async fileExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a file's contents as a UTF-8 string.
   * Returns null if the file does not exist.
   */
  public async readFile(uri: vscode.Uri): Promise<string | null> {
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      return new TextDecoder('utf-8').decode(data);
    } catch {
      return null;
    }
  }

  /**
   * Write content to a file.
   * 
   * @param uri       - Target file URI
   * @param content   - File content to write
   * @param overwrite - If false, skips writing when file already exists
   * @returns true if the file was written, false if skipped
   */
  public async writeFile(
    uri: vscode.Uri,
    content: string,
    overwrite: boolean = false
  ): Promise<boolean> {
    // Check if file exists and we should NOT overwrite
    if (!overwrite && (await this.fileExists(uri))) {
      this.logger.info(
        `Skipping existing file (overwrite=false): ${uri.fsPath}`,
        'FileManager'
      );
      return false;
    }

    // Ensure parent directory exists
    const parentUri = vscode.Uri.joinPath(uri, '..');
    await this.createDirectory(parentUri);

    // Write the file
    const encoded = new TextEncoder().encode(content);
    await vscode.workspace.fs.writeFile(uri, encoded);
    this.logger.info(`Wrote file: ${uri.fsPath}`, 'FileManager');
    return true;
  }

  /**
   * Recursively create a directory (no-op if it already exists).
   */
  public async createDirectory(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(uri);
    } catch {
      // Directory likely already exists — safe to ignore
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Project Structure Operations
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Create the full project directory structure.
   * Creates all required directories under the project root.
   * 
   * @param rootUri     - The project root URI
   * @param directories - List of directory paths relative to root
   */
  public async createProjectStructure(
    rootUri: vscode.Uri,
    directories: readonly string[]
  ): Promise<void> {
    this.logger.section('Creating Project Structure');

    // Create root directory
    await this.createDirectory(rootUri);

    // Create each subdirectory
    for (const dir of directories) {
      const dirUri = vscode.Uri.joinPath(rootUri, dir);
      await this.createDirectory(dirUri);
      this.logger.info(`Created directory: ${dir}/`, 'FileManager');
    }
  }

  /**
   * Write all generated files to disk.
   * 
   * @param rootUri - Project root URI
   * @param files   - Map of relative path → GeneratedFile
   * @param overwrite - Whether to overwrite existing files
   * @returns Number of files successfully written
   */
  public async writeGeneratedFiles(
    rootUri: vscode.Uri,
    files: Map<string, GeneratedFile>,
    overwrite: boolean = false
  ): Promise<number> {
    let written = 0;

    for (const [path, file] of files) {
      if (file.status === 'error' || !file.content) {
        this.logger.warn(`Skipping file with errors: ${path}`, 'FileManager');
        continue;
      }

      const fileUri = vscode.Uri.joinPath(rootUri, path);

      // Ensure parent directories exist
      const parentDir = vscode.Uri.joinPath(fileUri, '..');
      await this.createDirectory(parentDir);

      const didWrite = await this.writeFile(fileUri, file.content, overwrite);
      if (didWrite) {
        written++;
      }
    }

    this.logger.info(`Wrote ${written} / ${files.size} files`, 'FileManager');
    return written;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Context-Awareness
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Scan the project root and read existing file contents.
   * This enables context-aware code generation: the Code Generator Agent
   * can see what already exists before generating new files.
   * 
   * @param rootUri - Project root URI
   * @param filePaths - Specific file paths to read (relative to root)
   * @returns Map of relative path → file content
   */
  public async getExistingFileContents(
    rootUri: vscode.Uri,
    filePaths: string[]
  ): Promise<Map<string, string>> {
    const contents = new Map<string, string>();

    for (const filePath of filePaths) {
      const fileUri = vscode.Uri.joinPath(rootUri, filePath);
      const content = await this.readFile(fileUri);
      if (content !== null) {
        contents.set(filePath, content);
        this.logger.debug(
          `Read existing file: ${filePath} (${content.length} chars)`,
          'FileManager'
        );
      }
    }

    return contents;
  }

  /**
   * Discover all files in a project directory recursively.
   * Returns a list of relative paths from the root.
   * 
   * @param rootUri - Project root URI
   * @returns Array of relative file paths
   */
  public async discoverProjectFiles(rootUri: vscode.Uri): Promise<string[]> {
    const files: string[] = [];

    try {
      await this.walkDirectory(rootUri, rootUri, files);
    } catch {
      this.logger.warn('Failed to discover project files', 'FileManager');
    }

    return files;
  }

  /**
   * Recursively walk a directory and collect file paths.
   */
  private async walkDirectory(
    baseUri: vscode.Uri,
    currentUri: vscode.Uri,
    files: string[]
  ): Promise<void> {
    const entries = await vscode.workspace.fs.readDirectory(currentUri);

    for (const [name, type] of entries) {
      // Skip node_modules and hidden directories
      if (name === 'node_modules' || name.startsWith('.')) {
        continue;
      }

      const entryUri = vscode.Uri.joinPath(currentUri, name);

      if (type === vscode.FileType.Directory) {
        await this.walkDirectory(baseUri, entryUri, files);
      } else if (type === vscode.FileType.File) {
        // Compute relative path from base
        const relativePath = entryUri.fsPath.replace(baseUri.fsPath + '/', '');
        files.push(relativePath);
      }
    }
  }

  /**
   * Create a .env file with default environment variables.
   */
  public async createEnvFile(
    rootUri: vscode.Uri,
    projectName: string
  ): Promise<void> {
    const envContent = [
      `# ${projectName} — Environment Variables`,
      `PORT=3000`,
      `MONGODB_URI=mongodb://localhost:27017/${projectName.toLowerCase().replace(/\s+/g, '-')}`,
      `NODE_ENV=development`,
      `JWT_SECRET=your_jwt_secret_here_change_in_production`,
      '',
    ].join('\n');

    const envUri = vscode.Uri.joinPath(rootUri, '.env');
    await this.writeFile(envUri, envContent, false);
  }
}
