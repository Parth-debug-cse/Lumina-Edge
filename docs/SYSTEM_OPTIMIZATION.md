\# Technical Specification: System State Optimization



To achieve stable inference on a Low Physical RAM found in most Consumer Systems, the host OS environment must be transitioned into a "High-Efficiency" state. This document outlines the engineering rationale behind the Lumina Edge reclamation protocol.



\## 1. Memory Topography Management

Windows 10/11 typically maintains a "Standby List" (cached data) and "Memory Compression" processes. While beneficial for general use, these create non-deterministic latency spikes during LLM tensor operations.

\* \*\*Optimization:\*\* The `optimize\_system.ps1` script flushes the standby list to maximize the \*\*Available Physical Memory\*\* pool.



\## 2. Service-Level Overhead

Background services such as \*\*WSL\*\* and \*\*Windows Search\*\* maintain persistent heap allocations. 

\* \*\*Action:\*\* Programmatic suspension of these services reclaims ~1.2GB to 1.5GB of Commit Charge, preventing the system from utilizing the Disk Paging File, which would otherwise degrade tokens-per-second (t/s) performance.



\## 3. UMA \& BIOS Configuration

For Integrated Graphics (Intel UHD/Iris), the \*\*Pre-allocated Video Memory\*\* must be minimized (\*\*32MB\*\*).

\* \*\*Rationale:\*\* Modern Vulkan drivers utilize \*\*Dynamic Shared Memory\*\*. Locking 512MB or 1GB at the BIOS level creates a "Hard Wall" that the CPU cannot access, leading to Out-of-Memory (OOM) errors. Minimizing the buffer allows for a fluid, unified memory architecture.

