<!--
Babel — Prompt Operating System
Copyright © 2025–2026 Jonathan Gomez Aguilar
Licensed under the MIT License
Full license: https://github.com/gthgomez/Babel/blob/main/LICENSE
-->

# Project Overlay — Example LLM Router

## Purpose

Sanitized example overlay for a multi-provider LLM routing product.

## Example Stack

- provider routing service
- streaming UI
- normalized server-side event handling
- usage and cost tracking

## Hard Invariants

- ownership checks happen server-side
- provider responses normalize into one stable stream contract
- partial failures must degrade predictably
- usage accounting must stay explicit

## Primary Objects

- router manifests
- conversations
- provider responses
- usage meters
