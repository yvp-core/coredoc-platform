import { StableIdGenerator } from '@coredoc/core';
import { describe, expect, it } from 'vitest';
import { type PythonFile } from './python-cst.js';
import { extractPythonQueueEdges } from './python-queue.js';
import { parseSource } from '../../tree-sitter/tree-sitter-loader.js';

/** Same seed the parser uses — assertions recompute canonical ids through it. */
const ID = new StableIdGenerator('/demo', 'demo');

async function file(relPath: string, source: string): Promise<PythonFile> {
  return { relPath, source, root: await parseSource('python', source) };
}

describe('extractPythonQueueEdges — Celery producer→task call edges (S9 queue half)', () => {
  it('resolves a same-file `sync.delay(...)` producer to its @shared_task', async () => {
    const src = `
from celery import shared_task

@shared_task
def sync(x):
    return x

def producer():
    sync.delay(1)
`;
    const edges = extractPythonQueueEdges([await file('app/svc.py', src)], ID, {});
    expect(edges).toHaveLength(1);
    const e = edges[0];
    expect(e.callerId).toBe(ID.functionId('app/svc.py', 'producer'));
    expect(e.calleeId).toBe(ID.functionId('app/svc.py', 'sync'));
    expect(e.provenance).toBe('py-import');
    expect(e.isMethodCall).toBe(true);
  });

  it('resolves an imported `sync.delay(...)` producer across files via the import table', async () => {
    const tasks = `
from celery import shared_task

@shared_task
def sync(x):
    return x
`;
    const caller = `
from tasks import sync

def producer():
    sync.delay(2)
`;
    const edges = extractPythonQueueEdges([await file('tasks.py', tasks), await file('caller.py', caller)], ID, {});
    expect(edges).toHaveLength(1);
    const e = edges[0];
    expect(e.callerId).toBe(ID.functionId('caller.py', 'producer'));
    expect(e.calleeId).toBe(ID.functionId('tasks.py', 'sync'));
    expect(e.provenance).toBe('py-import');
  });

  it('resolves an `.apply_async()` producer the same as `.delay()`', async () => {
    const src = `
from celery import shared_task

@shared_task
def sync(x):
    return x

def producer():
    sync.apply_async(args=[1])
`;
    const edges = extractPythonQueueEdges([await file('app/svc.py', src)], ID, {});
    expect(edges).toHaveLength(1);
    expect(edges[0].calleeId).toBe(ID.functionId('app/svc.py', 'sync'));
  });

  it('DROPS an unresolved `foo.delay()` where foo is not a task (precision-first)', async () => {
    const src = `
def producer():
    foo.delay()
`;
    const edges = extractPythonQueueEdges([await file('app/svc.py', src)], ID, {});
    expect(edges).toHaveLength(0);
  });

  it('honors a custom taskDecorators config for the consumer side', async () => {
    const src = `
@task
def sync(x):
    return x

def producer():
    sync.delay(1)
`;
    const edges = extractPythonQueueEdges([await file('app/svc.py', src)], ID, { taskDecorators: ['task'] });
    expect(edges).toHaveLength(1);
    expect(edges[0].calleeId).toBe(ID.functionId('app/svc.py', 'sync'));
  });
});
