import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from "node:fs";
import { join } from "node:path";

/*
 * Defensive reads under an agent-written KIMI_CODE_HOME: nothing here follows a symlink
 * or a hard link planted out of the tree, or opens a FIFO that would block the event loop
 * on a synchronous read. Files are opened O_NOFOLLOW|O_NONBLOCK and read only when the fd
 * is a regular file with one name.
 *
 * On Linux every directory is opened O_DIRECTORY|O_NOFOLLOW and the next name is resolved
 * through its `/proc/self/fd/<fd>` magic link (Node has no openat), so no path component
 * can be swapped for a symlink between a check and the open: the walk is a boundary even
 * against a less-privileged owner of the tree, which is what lets root read the usage of a
 * kimi child dropped to the worker uid (FRG-5676). Without /proc the walk falls back to
 * lstat-then-open, which refuses links only at the last component (`fdWalk()` is false).
 */

const FD_DIR = "/proc/self/fd";

let hasFdDir: boolean | undefined;

/** True when directories are held open by fd, so every path component is link-safe.
 *  Probed on first use, not at import. */
export function fdWalk(): boolean {
  hasFdDir ??= existsSync(FD_DIR);
  return hasFdDir;
}

/** A directory inside the tree: a path under which a single child name resolves safely. */
export type Dir = string;

/** A one-name path component (never empty, `.`, `..` or containing a separator). */
function isName(name: string): boolean {
  return name !== "" && name !== "." && name !== ".." && !name.includes("/");
}

/** Holds the directory fds one walk opens; `release` frees one, `close` frees them all. */
export class TreeWalk {
  private readonly fds = new Map<Dir, number>();

  /** The plain directory at `path` (the tree's root), or null. */
  root(path: string): Dir | null {
    return this.open(path);
  }

  /** The plain directory `name` inside `parent`, or null. */
  dir(parent: Dir, name: string): Dir | null {
    return isName(name) ? this.open(join(parent, name)) : null;
  }

  /** The names of the plain subdirectories of `parent`. */
  subdirs(parent: Dir): string[] {
    try {
      return readdirSync(parent, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  /** Up to `max` bytes of the file `name` in `parent` from `offset` as UTF-8, with the byte
   *  count and the file's mtime; null when it is not a plain regular file or has nothing
   *  past `offset`. */
  file(
    parent: Dir,
    name: string,
    offset: number,
    max: number,
  ): { text: string; bytes: number; mtimeMs: number } | null {
    if (!isName(name)) return null;
    let fd: number;
    try {
      fd = openSync(
        join(parent, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      return null;
    }
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size <= offset) return null;
      const buf = Buffer.allocUnsafe(Math.min(st.size - offset, max));
      const bytesRead = readSync(fd, buf, 0, buf.length, offset);
      return { text: buf.toString("utf-8", 0, bytesRead), bytes: bytesRead, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  /** Close `dir` (a scan visiting many dirs releases each, so it holds few fds at once). */
  release(dir: Dir | null): void {
    const fd = dir === null ? undefined : this.fds.get(dir);
    if (dir === null || fd === undefined) return;
    this.fds.delete(dir);
    closeSync(fd);
  }

  close(): void {
    for (const fd of this.fds.values()) closeSync(fd);
    this.fds.clear();
  }

  private open(path: string): Dir | null {
    if (!fdWalk()) {
      try {
        return lstatSync(path).isDirectory() ? path : null;
      } catch {
        return null;
      }
    }
    try {
      const fd = openSync(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const dir = `${FD_DIR}/${fd}`;
      this.fds.set(dir, fd);
      return dir;
    } catch {
      return null;
    }
  }
}
