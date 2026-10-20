@echo off
rem Starts the second Tdarr node with encodes pinned to the RTX 2070 SUPER (by UUID, not index).
set CUDA_VISIBLE_DEVICES=GPU-cbda3789-545b-0581-8fa2-86b5c0cbfda2
cd /d D:\Tdarr2\Tdarr_Node
Tdarr_Node.exe
