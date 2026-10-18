@echo off
rem Starts the Tdarr node with encodes pinned to the RTX 4070 SUPER (by UUID, not index).
set CUDA_VISIBLE_DEVICES=GPU-3cbe5267-c72c-2d08-c4a7-e61fd8c0917e
cd /d D:\Tdarr\Tdarr_Node
Tdarr_Node.exe
