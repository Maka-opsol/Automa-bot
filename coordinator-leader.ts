'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getDb() { return _deps.database?.db; }

const { log, logError } = require('./logger');
const CONFIG = require('./get-config');

const HEARTBEAT_INTERVAL_MS = 20000;          // More frequent heartbeats
const WORKER_TIMEOUT_MS = 90000;              // More forgiving worker timeout
const LEADER_ELECTION_LOCK = 'leader_lock';
const LOCK_TTL_MS = 120000;                   // 2-minute lock TTL (was 60s)
const HEARTBEAT_JITTER_MS = 5000;             // Jitter to prevent thundering herd

class Coordinator {
  workers: any;
  tasks: any;
  isLeader: any;
  leaderId: any;
  electionInProgress: any;
  _cleanupInterval: any;
  _heartbeatInterval: any;
  _taskInterval: any;

  constructor() {
    this.workers = new Map();
    this.tasks = new Map();
    this.isLeader = false;
    this.leaderId = null;
    this.electionInProgress = false;
  }

  /**
   * Recover pending tasks from the database after a restart.
   * Without this, all in-progress tasks are lost when the process restarts.
   */
  _recoverPendingTasks() { 
    try {
      const pending = getDb()?.prepare(`SELECT * FROM assigned_tasks WHERE status = 'assigned'`).all();
      for (const task of pending) {
        // Check if the assigned worker has a recent heartbeat
        const worker = getDb()?.prepare(`SELECT last_heartbeat FROM workers WHERE id = ?`).get(task.worker_id);
        if (!worker || Date.now() - worker.last_heartbeat > WORKER_TIMEOUT_MS) {
          // Worker is dead or missing — re-queue the task
          getDb()?.prepare(`UPDATE assigned_tasks SET status = 'failed', completed_at = ?, error = ? WHERE task_id = ?`)
            .run(Date.now(), 'Worker lost on restart', task.task_id);
          log(`Recovered task ${task.task_id}: worker ${task.worker_id} lost on restart`, 'WARN', 'coordinator');
        } else {
          // Worker is alive — restore to in-memory map
          try {
            const taskData = JSON.parse(task.task_data);
            this.tasks.set(task.task_id, { task: taskData, assignedTo: task.worker_id, assignedAt: task.assigned_at, status: 'assigned' });
          } catch (_e: any) {
            getDb()?.prepare(`UPDATE assigned_tasks SET status = 'failed', completed_at = ?, error = ? WHERE task_id = ?`)
              .run(Date.now(), 'Task data corrupt on recovery', task.task_id);
          }
        }
      }
      if (pending.length > 0) {
        log(`Recovered ${pending.length} pending tasks from database`, 'INFO', 'coordinator');
      }
    } catch (err: any) {
      logError('Failed to recover pending tasks', err);
    }
  }

  async electLeader() { 
    if (this.electionInProgress) return;
    this.electionInProgress = true;
    try {
      const now = Date.now();
      const workerId = process.pid.toString();
      const expiresAt = now + LOCK_TTL_MS;
      // Atomic leader acquisition using UPDATE with WHERE clause (prevents TOCTOU race)
      const stmt = getDb()?.prepare(`
        UPDATE coordinator_lock
        SET holder = ?, acquired_at = ?, expires_at = ?
        WHERE id = ? AND (expires_at <= ? OR holder = ?)
      `);
      const info = stmt.run(workerId, now, expiresAt, LEADER_ELECTION_LOCK, now, workerId);
      if (info.changes === 0) {
        // Another process holds the lock
        const current = getDb()?.prepare(`SELECT holder, expires_at FROM coordinator_lock WHERE id = ?`).get(LEADER_ELECTION_LOCK);
        this.isLeader = false;
        this.leaderId = current ? current.holder : null;
        if (current) {
          log(`Existing lock held by ${current.holder} (expires in ${Math.ceil((current.expires_at - now) / 1000)}s)`, 'INFO', 'coordinator');
        }
        return;
      }
      const row = getDb()?.prepare(`SELECT holder FROM coordinator_lock WHERE id = ?`).get(LEADER_ELECTION_LOCK);
      if (row && row.holder === workerId) {
        this.isLeader = true;
        this.leaderId = workerId;
        log(`Elected as leader: ${workerId}`, 'INFO', 'coordinator');
        this._recoverPendingTasks();
        this.startHeartbeat();
        this.scheduleTaskAssignment();
      } else {
        this.isLeader = false;
        this.leaderId = row ? row.holder : null;
        log(`Leader is ${this.leaderId}`, 'INFO', 'coordinator');
      }
    } catch (err: any) {
      logError('Leader election failed', err);
    } finally {
      this.electionInProgress = false;
    }

    // Periodically clean up expired worker registrations
    if (!this._cleanupInterval) {
      this._cleanupInterval = setInterval(() => {
        try {
          const now = Date.now();
          getDb()?.prepare(`DELETE FROM workers WHERE last_heartbeat < ?`).run(now - WORKER_TIMEOUT_MS);
        } catch (err: any) {
          logError('Worker cleanup failed', err);
        }
      }, HEARTBEAT_INTERVAL_MS * 3);
      if (this._cleanupInterval && typeof this._cleanupInterval.unref === 'function') {
        this._cleanupInterval.unref();
      }
    }
  }

  startHeartbeat() { 
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
    // Add jitter to prevent sync issues in multi-process scenarios
    const jitteredInterval = HEARTBEAT_INTERVAL_MS + Math.floor(Math.random() * HEARTBEAT_JITTER_MS);
    this._heartbeatInterval = setInterval(() => {
      if (!this.isLeader) return;
      try {
        const now = Date.now();
        getDb()?.prepare(`
          UPDATE coordinator_lock SET expires_at = ? WHERE id = ? AND holder = ?
        `).run(now + LOCK_TTL_MS, LEADER_ELECTION_LOCK, this.leaderId);
      } catch (err: any) {
        logError('Heartbeat failed', err);
      }
    }, jitteredInterval);
    if (this._heartbeatInterval && typeof this._heartbeatInterval.unref === 'function') {
      this._heartbeatInterval.unref();
    }
  }

  registerWorker(workerId: any, capabilities: any) { 
    try {
      getDb()?.prepare(`
        INSERT OR REPLACE INTO workers (id, last_heartbeat, capabilities, status)
        VALUES(?, ?, ?, ?)
      `).run(workerId, Date.now(), JSON.stringify(capabilities), 'active');
      this.workers.set(workerId, { lastHeartbeat: Date.now(), capabilities, status: 'active' });
      log(`Worker registered: ${workerId}`, 'DEBUG', 'coordinator');
    } catch (err: any) {
      logError('Failed to register worker', err);
    }
  }

  unregisterWorker(workerId: any) { 
    try {
      getDb()?.prepare(`DELETE FROM workers WHERE id = ?`).run(workerId);
      this.workers.delete(workerId);
      log(`Worker unregistered: ${workerId}`, 'DEBUG', 'coordinator');
    } catch (err: any) {
      logError('Failed to unregister worker', err);
    }
  }

  getActiveWorkers() { 
    const now = Date.now();
    const active = [];
    const stale = [];
    for (const [id, data] of this.workers) {
      if (now - data.lastHeartbeat < WORKER_TIMEOUT_MS) {
        active.push(id);
      } else {
        stale.push(id);
      }
    }
    for (const id of stale) {
      this.workers.delete(id);
    }
    return active;
  }

  assignTask(task: any) { 
    if (!this.isLeader) return null;
    const workers = this.getActiveWorkers();
    if (workers.length === 0) return null;
    const workerId = workers[Math.floor(Math.random() * workers.length)];
    this.tasks.set(task.id, { task, assignedTo: workerId, assignedAt: Date.now(), status: 'assigned' });
    try {
      getDb()?.prepare(`
        INSERT OR REPLACE INTO assigned_tasks (task_id, worker_id, assigned_at, status, task_data)
        VALUES(?, ?, ?, ?, ?)
      `).run(task.id, workerId, Date.now(), 'assigned', JSON.stringify(task));
      log(`Assigned task ${task.id} to worker ${workerId}`, 'INFO', 'coordinator');
      return workerId;
    } catch (err: any) {
      logError('Failed to assign task', err);
      return null;
    }
  }

  completeTask(taskId: any, result: any) { 
    try {
      getDb()?.prepare(`
        UPDATE assigned_tasks SET status = 'completed', completed_at = ?, result = ?
        WHERE task_id = ?
      `).run(Date.now(), JSON.stringify(result), taskId);
      this.tasks.delete(taskId);
      log(`Task ${taskId} completed`, 'INFO', 'coordinator');
    } catch (err: any) {
      logError('Failed to complete task', err);
    }
  }

  failTask(taskId: any, error: any) { 
    try {
      getDb()?.prepare(`
        UPDATE assigned_tasks SET status = 'failed', completed_at = ?, error = ?
        WHERE task_id = ?
      `).run(Date.now(), error, taskId);
      this.tasks.delete(taskId);
      log(`Task ${taskId} failed: ${error}`, 'WARN', 'coordinator');
    } catch (err: any) {
      logError('Failed to mark task as failed', err);
    }
  }

  getPendingTasks() { 
    try {
      return getDb()?.prepare(`SELECT * FROM assigned_tasks WHERE status = 'assigned'`).all();
    } catch (err: any) {
      logError('Failed to get pending tasks', err);
      return [];
    }
  }

  scheduleTaskAssignment() { 
    if (this._taskInterval) clearInterval(this._taskInterval);
    this._taskInterval = setInterval(() => {
      if (!this.isLeader) return;
      const pending = this.getPendingTasks();
      for (const task of pending) {
        // Check worker liveness against DB (survives restart) not just in-memory Map
        let workerAlive = false;
        try {
          const worker = getDb()?.prepare(`SELECT last_heartbeat FROM workers WHERE id = ?`).get(task.worker_id);
          workerAlive = worker && (Date.now() - worker.last_heartbeat <= WORKER_TIMEOUT_MS);
        } catch (_e: any) {}
        if (!workerAlive || Date.now() - task.assigned_at > WORKER_TIMEOUT_MS) {
          this.failTask(task.task_id, 'Worker timeout');
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    if (this._taskInterval && typeof this._taskInterval.unref === 'function') {
      this._taskInterval.unref();
    }
  }

  getStatus() { 
    return {
      isLeader: this.isLeader,
      leaderId: this.leaderId,
      workers: this.workers.size,
      activeWorkers: this.getActiveWorkers().length,
      tasks: this.tasks.size,
    };
  }

  shutdown() { 
    if (this._heartbeatInterval) clearInterval(this._heartbeatInterval);
    if (this._taskInterval) clearInterval(this._taskInterval);
    if (this.isLeader) {
      try {
        getDb()?.prepare(`DELETE FROM coordinator_lock WHERE id = ?`).run(LEADER_ELECTION_LOCK);
      } catch (err: any) {}
    }
    log('Coordinator shutdown', 'INFO', 'coordinator');
  }
}

const coordinator = new Coordinator();

function startCoordinator() { 
  coordinator.electLeader().catch(err => logError('Leader election failed', err));
  return coordinator;
}

module.exports = { coordinator, startCoordinator, _injectDependencies };
