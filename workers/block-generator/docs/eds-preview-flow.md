# EDS Block Generation & Preview Flow

## Overview

This document describes the complete flow for generating, previewing, refining, and deploying EDS blocks using real AEM Edge Delivery Services preview environments.

## Key Concepts

### EDS Block Structure

EDS blocks consist of three parts:

1. **Authoring HTML** - Simple div structure stored in DA (Document Authoring)
   ```html
   <div class="speed-comparison">
     <div>
       <div>Cell 1 content</div>
       <div>Cell 2 content</div>
     </div>
   </div>
   ```

2. **Block JS** - `decorate(block)` function that transforms authoring HTML into rendered DOM
   ```javascript
   export default function decorate(block) {
     // Transform simple structure into rich rendered HTML
   }
   ```

3. **Block CSS** - Styles targeting the **decorated output**, not the authoring HTML

### EDS Hydration Flow

When a page loads in EDS:
1. Core scripts (`/scripts/scripts.js`) discover blocks by class name
2. Block-specific JS is loaded (`/blocks/{name}/{name}.js`)
3. Block-specific CSS is loaded (`/blocks/{name}/{name}.css`)
4. `decorate(block)` is called to transform the HTML
5. CSS styles the transformed output

## Generation Flow

### Session Management

Each generation session gets a unique **session ID** (6 alphanumeric characters):
- Generated once when user starts a new block generation
- Shared across all options and iterations in that session
- Used to group related branches and DA pages for easy cleanup

Example session ID: `x7k2m9`

### Naming Conventions

**Note:** One GitHub repository = one site. No site-specific branches.

#### GitHub Branches

```
{block-name}-{session}-{opt}-{iter}
```

Examples:
- `speed-comparison-x7k2m9-1-1` (Option 1, Iteration 1)
- `speed-comparison-x7k2m9-1-2` (Option 1, Iteration 2)
- `speed-comparison-x7k2m9-2-1` (Option 2, Iteration 1)
- `speed-comparison-x7k2m9-3-3` (Option 3, Iteration 3)

Branch contents:
```
blocks/{block-name}/{block-name}.js
blocks/{block-name}/{block-name}.css
```

#### DA Pages

```
{base-path}/{block-name}-{session}-{opt}-{iter}
```

The `base-path` is configurable via the DA folder URL. Default is `/drafts/gen`.

Examples (with default base path):
- `/drafts/gen/speed-comparison-x7k2m9-1-1`
- `/drafts/gen/speed-comparison-x7k2m9-2-3`

Page contents: Authoring HTML wrapped in proper EDS page structure

#### Preview URLs

```
https://{block}-{session}-{opt}-{iter}--{repo}--{owner}.aem.page{base-path}/{block}-{session}-{opt}-{iter}
```

Examples:
- `https://speed-comparison-x7k2m9-1-1--neocat-2--paolomoz.aem.page/drafts/gen/speed-comparison-x7k2m9-1-1`
- `https://speed-comparison-x7k2m9-2-3--neocat-2--paolomoz.aem.page/drafts/gen/speed-comparison-x7k2m9-2-3`

### Branch Management

- All variant branches are created from `main`
- Winner is merged back to `main`
- Cleanup deletes all temporary session branches

## Complete Workflow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GENERATION PHASE                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  User provides:                                                             │
│  - Page URL                                                                 │
│  - Screenshot of target section                                             │
│  - Element HTML or XPath                                                    │
│  - GitHub repo URL (e.g., https://github.com/owner/repo)                   │
│  - DA folder URL (e.g., https://da.live/org/site/drafts/gen)               │
│                                                                             │
│                              ▼                                              │
│                                                                             │
│  System generates session ID: x7k2m9                                        │
│                                                                             │
│                              ▼                                              │
│                                                                             │
│  Generate 3 Options (parallel):                                             │
│  ┌─────────────────┬─────────────────┬─────────────────┐                   │
│  │    Option 1     │    Option 2     │    Option 3     │                   │
│  │  (approach A)   │  (approach B)   │  (approach C)   │                   │
│  └────────┬────────┴────────┬────────┴────────┬────────┘                   │
│           │                 │                 │                             │
│           ▼                 ▼                 ▼                             │
│                                                                             │
│  For each option, push to GitHub + DA:                                      │
│                                                                             │
│  Option 1:                                                                  │
│    Branch: speed-comparison-x7k2m9-1-1                                      │
│    DA:     /drafts/gen/speed-comparison-x7k2m9-1-1                          │
│    Preview: https://speed-comparison-x7k2m9-1-1--repo--owner.aem.page/...   │
│                                                                             │
│  Option 2:                                                                  │
│    Branch: speed-comparison-x7k2m9-2-1                                      │
│    DA:     /drafts/gen/speed-comparison-x7k2m9-2-1                          │
│    Preview: https://speed-comparison-x7k2m9-2-1--repo--owner.aem.page/...   │
│                                                                             │
│  Option 3:                                                                  │
│    Branch: speed-comparison-x7k2m9-3-1                                      │
│    DA:     /drafts/gen/speed-comparison-x7k2m9-3-1                          │
│    Preview: https://speed-comparison-x7k2m9-3-1--repo--owner.aem.page/...   │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           PREVIEW & COMPARE                                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  All 3 preview URLs are live simultaneously                                 │
│  User can open all 3 in separate tabs to compare                            │
│                                                                             │
│  System captures screenshots from each preview URL                          │
│  Displays side-by-side comparison with original screenshot                  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           REFINEMENT PHASE                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  User selects an option to refine (e.g., Option 2)                          │
│  Provides refinement instructions                                            │
│                                                                             │
│                              ▼                                              │
│                                                                             │
│  System generates refined version:                                          │
│    Branch: speed-comparison-x7k2m9-2-2                                      │
│    DA:     /drafts/gen/speed-comparison-x7k2m9-2-2                          │
│    Preview: https://speed-comparison-x7k2m9-2-2--repo--owner.aem.page/...   │
│                                                                             │
│  Previous iteration (2-1) remains available for comparison                  │
│                                                                             │
│  Repeat refinement as needed (2-3, 2-4, etc.)                              │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                           WINNER SELECTION                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  User picks winner (e.g., Option 2, Iteration 3)                            │
│                                                                             │
│                              ▼                                              │
│                                                                             │
│  Finalization:                                                              │
│                                                                             │
│  1. MERGE CODE                                                              │
│     Merge branch speed-comparison-x7k2m9-2-3 into main                      │
│     Result: blocks/speed-comparison/ now in main branch                     │
│                                                                             │
│  2. MOVE CONTENT (optional)                                                 │
│     Move DA page from /drafts/gen/speed-comparison-x7k2m9-2-3               │
│     to final location (e.g., /blocks/speed-comparison or actual page)       │
│                                                                             │
│  3. CLEANUP                                                                 │
│     Delete all gen branches for this session:                               │
│       - speed-comparison-x7k2m9-1-1                                         │
│       - speed-comparison-x7k2m9-1-2                                         │
│       - speed-comparison-x7k2m9-2-1                                         │
│       - speed-comparison-x7k2m9-2-2                                         │
│       - speed-comparison-x7k2m9-3-1                                         │
│       (winner branch already merged, can be deleted too)                    │
│                                                                             │
│     Delete all gen DA pages for this session:                               │
│       - /drafts/gen/speed-comparison-x7k2m9-*                               │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## API Endpoints

### POST /block-generate

Generates initial block code from screenshot.

**Request:**
```json
{
  "url": "https://www.example.com/page.html",
  "screenshot": "<base64>",
  "html": "<div>...</div>",
  "xpath": "/html/body/div[2]/...",
  "github": {
    "owner": "myorg",
    "repo": "mysite",
    "token": "ghp_xxx"
  },
  "da": {
    "org": "myorg",
    "site": "mysite",
    "basePath": "/drafts/gen"
  }
}
```

**Response:**
```json
{
  "success": true,
  "sessionId": "x7k2m9",
  "blockName": "speed-comparison",
  "options": [
    {
      "option": 1,
      "iteration": 1,
      "branch": "speed-comparison-x7k2m9-1-1",
      "daPath": "/drafts/gen/speed-comparison-x7k2m9-1-1",
      "previewUrl": "https://speed-comparison-x7k2m9-1-1--mysite--myorg.aem.page/drafts/gen/speed-comparison-x7k2m9-1-1",
      "html": "...",
      "css": "...",
      "js": "..."
    },
    // ... options 2 and 3
  ]
}
```

### POST /block-refine

Refines an existing block variant.

**Request:**
```json
{
  "sessionId": "x7k2m9",
  "option": 2,
  "currentIteration": 2,
  "screenshot": "<base64 of original>",
  "prompt": "Make the heading larger and add more padding",
  "github": { ... },
  "da": { ... }
}
```

**Response:**
```json
{
  "success": true,
  "option": 2,
  "iteration": 3,
  "branch": "speed-comparison-x7k2m9-2-3",
  "daPath": "/drafts/gen/speed-comparison-x7k2m9-2-3",
  "previewUrl": "https://...",
  "html": "...",
  "css": "...",
  "js": "..."
}
```

### POST /block-finalize

Finalizes the winning variant by merging to main.

**Request:**
```json
{
  "sessionId": "x7k2m9",
  "blockName": "speed-comparison",
  "winner": {
    "option": 2,
    "iteration": 3
  },
  "github": {
    "owner": "myorg",
    "repo": "mysite",
    "token": "ghp_xxx"
  },
  "da": {
    "org": "myorg",
    "site": "mysite",
    "basePath": "/drafts/gen"
  },
  "cleanup": true
}
```

**Response:**
```json
{
  "success": true,
  "merged": {
    "branch": "speed-comparison-x7k2m9-2-3",
    "into": "main",
    "commitSha": "abc123"
  },
  "cleanup": {
    "branchesDeleted": 5,
    "pagesDeleted": 5
  }
}
```

### DELETE /block-cleanup

Cleans up a generation session without finalizing.

**Request:**
```json
{
  "sessionId": "x7k2m9",
  "blockName": "speed-comparison",
  "github": { ... },
  "da": { ... }
}
```

## Test UI Flow

1. **Input Phase**
   - User enters page URL, uploads screenshot
   - User provides HTML or XPath for the target section
   - User enters GitHub repository URL (e.g., `https://github.com/owner/repo`)
   - User enters DA folder URL (e.g., `https://da.live/org/site/drafts/gen`)
   - User enters GitHub token
   - System generates session ID

2. **Generation Phase**
   - "Generate Block" creates 3 options
   - Each option is pushed to GitHub branch + DA page
   - Preview URLs are displayed for all 3 options

3. **Comparison Phase**
   - User can click preview URLs to see real EDS rendering
   - System shows screenshots from preview URLs alongside original
   - User selects which option(s) to refine

4. **Refinement Phase**
   - User provides refinement instructions
   - "Refine" creates new iteration for selected option
   - New preview URL is displayed
   - Previous iterations remain accessible

5. **Finalization Phase**
   - User clicks "Pick Winner" and selects best variant
   - System merges winning branch to main
   - System cleans up all temporary branches and DA pages
   - Final block is ready in main branch

## Error Handling

- **Branch exists:** Overwrite (same session) or fail (different session)
- **DA page exists:** Overwrite (same session) or fail (different session)
- **GitHub API errors:** Retry with exponential backoff
- **Preview not ready:** Poll until preview builds (typically 10-30 seconds)

## Security Considerations

- GitHub tokens should have minimal required permissions (repo contents)
- DA tokens should be scoped to the specific org/site
- Session IDs are random and unpredictable
- Cleanup should verify session ownership before deleting
