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
import argparse

def load_config(config_path: str = "config.json") -> dict:
    with open(config_path, 'r') as f:
        return json.load(f)

def check_dependencies():
    """Check if required dependencies are installed"""
    missing = []
    
    try:
        import tiktoken
    except ImportError:
        missing.append("tiktoken")
    
    try:
        import chromadb
    except ImportError:
        missing.append("chromadb")
    
    try:
        from sentence_transformers import SentenceTransformer
    except ImportError:
        missing.append("sentence-transformers")
    
    try:
        import pymupdf
    except ImportError:
        missing.append("pymupdf (PyMuPDF)")
    
    try:
        from docx import Document as DocxDocument
    except ImportError:
        missing.append("python-docx")
    
    if missing:
        print("ERROR: Missing required dependencies:")
        for pkg in missing:
            print(f"  - {pkg}")
        print("\nInstall with: pip install " + " ".join(missing))
        sys.exit(1)

# Text extraction functions
def extract_text_from_pdf(pdf_path: str) -> str:
    """Extract text from PDF using PyMuPDF"""
    import pymupdf
    doc = pymupdf.open(pdf_path)
    text = ""
    for page in doc:
        text += page.get_text()
    doc.close()
    return text

def extract_text_from_docx(docx_path: str) -> str:
    """Extract text from DOCX"""
    from docx import Document as DocxDocument
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
def chunk_text(text: str, chunk_size: int = 512, overlap: int = 50, verbose: bool = False) -> List[str]:
    """
    Split text into overlapping chunks using tiktoken tokenizer
    """
    import tiktoken
    encoding = tiktoken.get_encoding("cl100k_base")
    tokens = encoding.encode(text)
    
    if verbose:
        print(f"    Total tokens in document: {len(tokens)}")
        print(f"    Chunk size: {chunk_size}, Overlap: {overlap}")
    
    chunks = []
    start = 0
    chunk_num = 0
    
    while start < len(tokens):
        end = min(start + chunk_size, len(tokens))
        chunk_tokens = tokens[start:end]
        chunk_text = encoding.decode(chunk_tokens)
        chunks.append(chunk_text)
        
        if verbose:
            print(f"      Chunk {chunk_num}: tokens {start}-{end} (size: {len(chunk_tokens)})")
        
        # Move start forward by chunk_size - overlap
        start += (chunk_size - overlap)
        chunk_num += 1
        
        # Break if we've reached the end
        if end >= len(tokens):
            break
    
    if verbose:
        print(f"    Created {len(chunks)} chunks")
    
    return chunks

# Embedding and storage
def ingest_documents(doc_dir: str, config: dict, verbose: bool = False):
    """
    Main ingestion function:
    1. Walk directory for supported files
    2. Extract text
    3. Chunk text
    4. Embed chunks
    5. Store in ChromaDB
    """
    from sentence_transformers import SentenceTransformer
    import chromadb
    
    # Initialize embedding model
    embedding_model_name = config.get('embedding_model', 'all-MiniLM-L6-v2')
    print(f"Loading embedding model: {embedding_model_name}")
    try:
        embedding_model = SentenceTransformer(embedding_model_name)
        print(f"  ✓ Model loaded successfully")
    except Exception as e:
        print(f"  ✗ Failed to load embedding model: {e}")
        print("  Downloading model (this may take a few minutes)...")
        embedding_model = SentenceTransformer(embedding_model_name)
    
    # Initialize ChromaDB
    vectordb_path = config.get('vectordb_path', 'vectordb')
    os.makedirs(vectordb_path, exist_ok=True)
    client = chromadb.PersistentClient(path=vectordb_path)
    
    # Get or create collection
    use_case = config.get('use_case', 'default')
    collection_name = f"{use_case}_docs"
    
    try:
        collection = client.get_collection(name=collection_name)
        print(f"Using existing collection: {collection_name}")
        print(f"  Current document count: {collection.count()}")
    except:
        collection = client.create_collection(name=collection_name)
        print(f"Created new collection: {collection_name}")
    
    # Walk directory
    doc_path = Path(doc_dir)
    supported_exts = {'.pdf', '.docx', '.txt'}
    files = [f for f in doc_path.rglob('*') if f.suffix.lower() in supported_exts]
    
    if not files:
        print(f"\nWARNING: No supported documents found in {doc_dir}")
        print("Supported formats: PDF, DOCX, TXT")
        return
    
    print(f"\nFound {len(files)} document(s) to ingest")
    
    chunk_size = config.get('chunk_size', 512)
    chunk_overlap = config.get('chunk_overlap', 50)
    
    total_chunks = 0
    success_count = 0
    
    for file_path in files:
        print(f"\n📄 Processing: {file_path.name}")
        
        try:
            # Extract text
            text = extract_text(str(file_path))
            print(f"  Extracted {len(text)} characters")
            
            if len(text.strip()) == 0:
                print(f"  ⚠️ Document appears to be empty, skipping")
                continue
            
            # Chunk text
            chunks = chunk_text(
                text,
                chunk_size=chunk_size,
                overlap=chunk_overlap,
                verbose=verbose
            )
            print(f"  Created {len(chunks)} chunks")
            
            if len(chunks) == 0:
                print(f"  ⚠️ No chunks created, skipping")
                continue
            
            # Embed chunks
            print(f"  Generating embeddings...")
            embeddings = embedding_model.encode(chunks, show_progress_bar=False)
            
            # Prepare metadata
            ids = [f"{file_path.stem}_chunk_{i}" for i in range(len(chunks))]
            metadatas = [
                {
                    "source": file_path.name,
                    "chunk_id": i,
                    "total_chunks": len(chunks),
                    "file_path": str(file_path)
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
            print(f"  ✓ Ingested {len(chunks)} chunks successfully")
            total_chunks += len(chunks)
            success_count += 1
            
        except Exception as e:
            print(f"  ✗ Error processing file: {str(e)}")
            if verbose:
                import traceback
                traceback.print_exc()
            continue
    
    print(f"\n{'='*60}")
    print(f"✓ Ingestion complete!")
    print(f"  Files processed: {success_count}/{len(files)}")
    print(f"  Total chunks stored: {total_chunks}")
    print(f"  Collection: {collection_name}")
    print(f"  Total documents in collection: {collection.count()}")
    print(f"{'='*60}")

def main():
    parser = argparse.ArgumentParser(description="Ingest documents into Lumina Edge VectorDB")
    parser.add_argument("doc_dir", help="Directory containing documents to ingest")
    parser.add_argument("--verbose", "-v", action="store_true", help="Enable verbose output")
    args = parser.parse_args()
    
    doc_dir = args.doc_dir
    if not os.path.isdir(doc_dir):
        print(f"ERROR: {doc_dir} is not a valid directory")
        sys.exit(1)
    
    # Check dependencies first
    check_dependencies()
    
    config = load_config()
    
    if not config.get('rag_enabled', True):
        print("WARNING: RAG is disabled in config.json. Set 'rag_enabled': true to use this feature.")
        response = input("Continue anyway? (y/n): ")
        if response.lower() != 'y':
            sys.exit(1)
    
    ingest_documents(doc_dir, config, verbose=args.verbose)

if __name__ == "__main__":
    main()
