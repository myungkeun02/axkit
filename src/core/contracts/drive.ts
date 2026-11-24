/** Capability "files.drive-write": saves a document the assistant made into the owner's Google Drive. */
export interface DriveWriter {
  /**
   * Creates a Google Doc from Markdown inside a folder ax-kit made (created on first use). Only files ax-kit
   * created are ever visible to it (`drive.file` scope).
   */
  saveDocument(input: { name: string; markdown: string; folderName: string }, signal?: AbortSignal): Promise<{ id: string; url: string }>;
}
