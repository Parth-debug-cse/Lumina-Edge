#!/usr/bin/env python3
"""
Document Ingestion Pipeline for Lumina Edge
Supports PDF, DOCX, TXT files
Cross-platform (Windows, Linux, macOS)
"""

import os
import json
import sys
from pathlib import Path
from typing import List, Dict
import tiktoken
import chromadb
from sentence_transformers import SentenceTransformer
import pymupdf  # PyMuPDF
from docx import Document as DocxDocument

# Load config
def load_config(config_path: str = "config.json") -> dict:
    with open(config_path, 'r', encoding='utf-8') as f:
        return json.load(f)

# Text extraction functions
def extract_text_from_pdf(pdf_path: str) -> str:
    """Extract text from PDF using PyMuPDF"""
    doc = pymupdf.open(pdf_path)
    text = ""
    for page in doc:
        text += page.get_text()
    doc.close()
    return text

def extract_text_from_docx(docx_path: str) -> str:
    """Extract text from DOCX"""
    doc = DocxDocument(docx_path)
    return "\n".join([para.text for para in doc.paragraphs])

def extract_text_from_txt(txt_path: str) -> str:
    """Read plain text file"""
    with open(txt_path, 'r', encoding='utf-8', errors='ignore') as f:
        return f.read()

def extract_text(file_path: str) -> str:
    """Route to correct extractor based on file extension"""
    ext = Path(file_path).suffix.lower()
    if ext == '.pdf':
        return extract_text_from_pdf(file_path)
    elif ext == '.docx':
        return extract_text_from_docx(file_path)
    elif ext == '.txt':
        return extract_text_from_txt(file_path)
    else:
        raise ValueError(f"Unsupported file type: {ext}")

# Chunking logic
def chunk_text(text: str, chunk_size: int = 512, overlap: int = 50) -> List[str]:
    """
    Split text into overlapping chunks using tiktoken tokenizer
    """
    encoding = tiktoken.get_encoding("cl100k_base")
    tokens = encoding.encode(text)

    chunks = []
    start = 0
    while start < len(tokens):
        end = start + chunk_size
        chunk_tokens = tokens[start:end]
        chunk_text = encoding.decode(chunk_tokens)
        chunks.append(chunk_text)
        start += (chunk_size - overlap)

    return chunks

# Embedding and storage
def ingest_documents(doc_dir: str, config: dict):
    """
    Main ingestion function:
    1. Walk directory for supported files
    2. Extract text
    3. Chunk text
    4. Embed chunks
    5. Store in ChromaDB
    """
    # Initialize embedding model
    print(f"Loading embedding model: {config['embedding_model']}")
    embedding_model = SentenceTransformer(config['embedding_model'])

    # Initialize ChromaDB
    vectordb_path = config['vectordb_path']
    os.makedirs(vectordb_path, exist_ok=True)
    client = chromadb.PersistentClient(path=vectordb_path)

    # Get or create collection
    collection_name = f"{config['use_case']}_docs"
    try:
        collection = client.get_collection(name=collection_name)
        print(f"Using existing collection: {collection_name}")
    except Exception:
        collection = client.create_collection(name=collection_name)
        print(f"Created new collection: {collection_name}")

    # Walk directory
    doc_path = Path(doc_dir)
    supported_exts = {'.pdf', '.docx', '.txt'}
    files = [f for f in doc_path.rglob('*') if f.suffix.lower() in supported_exts]

    print(f"\nFound {len(files)} documents to ingest")

    for file_path in files:
        print(f"\nProcessing: {file_path.name}")

        try:
            # Extract text
            text = extract_text(str(file_path))
            print(f"  Extracted {len(text)} characters")

            # Chunk text
            chunks = chunk_text(
                text,
                chunk_size=config['chunk_size'],
                overlap=config['chunk_overlap']
            )
            print(f"  Created {len(chunks)} chunks")

            # Embed chunks
            embeddings = embedding_model.encode(chunks, show_progress_bar=False)

            # Prepare metadata
            ids = [f"{file_path.stem}_chunk_{i}" for i in range(len(chunks))]
            metadatas = [
                {
                    "source": file_path.name,
                    "chunk_id": i,
                    "total_chunks": len(chunks)
                }
                for i in range(len(chunks))
            ]

            # Store in ChromaDB
            collection.add(
                ids=ids,
                embeddings=embeddings.tolist(),
                documents=chunks,
                metadatas=metadatas
            )
            print(f"  Ingested successfully")

        except Exception as e:
            print(f"  Error: {str(e)}")
            continue

    print(f"\nIngestion complete. Total documents in collection: {collection.count()}")

def main():
    if len(sys.argv) < 2:
        print("Usage: python ingest_docs.py <document_directory>")
        print("Example: python ingest_docs.py demo_docs/")
        sys.exit(1)

    doc_dir = sys.argv[1]
    if not os.path.isdir(doc_dir):
        print(f"Error: {doc_dir} is not a valid directory")
        sys.exit(1)

    config = load_config()

    if not config.get('rag_enabled', False):
        print("Warning: RAG is disabled in config.json. Set 'rag_enabled': true to use this feature.")
        sys.exit(1)

    ingest_documents(doc_dir, config)

if __name__ == "__main__":
    main()
