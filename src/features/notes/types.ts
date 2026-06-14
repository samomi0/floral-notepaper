export interface NoteMetadata {
  id: string;
  title: string;
  fileName: string;
  category: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  wordCount: number;
  preview: string;
}

export interface Note extends Omit<NoteMetadata, "preview"> {
  content: string;
}

export interface SaveNoteRequest {
  title: string;
  content: string;
  category: string;
  tags: string[];
}

export interface Tag {
  id: string;
  name: string;
  color: string;
}

export interface ExternalFile {
  id: string;
  title: string;
  filePath: string;
}
