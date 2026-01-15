export type FileEntry = {
  file: File
  path: string // webkitRelativePath or name
}

export type TreeNode = {
  name: string
  path: string // '' for root, else 'a/b'
  dirs: Map<string, TreeNode>
  files: FileEntry[]
}

function splitPath(p: string): string[] {
  return p.split('/').filter(Boolean)
}

export function buildFileTree(entries: FileEntry[]): TreeNode {
  const root: TreeNode = { name: '', path: '', dirs: new Map(), files: [] }

  for (const e of entries) {
    const parts = splitPath(e.path)
    if (parts.length === 0) continue

    // If webkitRelativePath includes the file name at the end:
    const fileName = parts[parts.length - 1]!
    const dirParts = parts.slice(0, -1)

    let node = root
    let curPath = ''
    for (const d of dirParts) {
      curPath = curPath ? `${curPath}/${d}` : d
      let child = node.dirs.get(d)
      if (!child) {
        child = { name: d, path: curPath, dirs: new Map(), files: [] }
        node.dirs.set(d, child)
      }
      node = child
    }

    node.files.push({ file: e.file, path: e.path || fileName })
  }

  // Sort files within each dir by display name
  const sortNode = (n: TreeNode) => {
    n.files.sort((a, b) => a.path.localeCompare(b.path))
    for (const child of n.dirs.values()) sortNode(child)
  }
  sortNode(root)

  return root
}

export function getNode(root: TreeNode, path: string): TreeNode | null {
  if (!path) return root
  const parts = splitPath(path)
  let node: TreeNode = root
  for (const p of parts) {
    const next = node.dirs.get(p)
    if (!next) return null
    node = next
  }
  return node
}

export function breadcrumbParts(path: string): { name: string; path: string }[] {
  if (!path) return []
  const parts = splitPath(path)
  const out: { name: string; path: string }[] = []
  let cur = ''
  for (const p of parts) {
    cur = cur ? `${cur}/${p}` : p
    out.push({ name: p, path: cur })
  }
  return out
}


