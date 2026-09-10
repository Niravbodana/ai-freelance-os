import { useEffect, useState } from "react";
import { api } from "../api/client.js";

/**
 * Every credential the system needs, editable here after the dashboard's
 * own login (the browser's basic-auth prompt already gates this whole
 * app — this is that same "admin login", not a second one). Values are
 * encrypted at rest (services/crypto.js) and never round-trip back to the
 * browser in plaintext, only masked.
 */
export default function AdminSettings() {
  const [groups, setGroups] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [busyKey, setBusyKey] = useState(null);
  const [testResults, setTestResults] = useState({});
  const [error, setError] = useState(null);

  async function refresh() {
    try {
      const data = await api.getSettings();
      setGroups(data.groups);
      setError(null);
    } catch (err) {
      setError(String(err));
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function save(key) {
    const value = drafts[key];
    if (!value) return;
    setBusyKey(key);
    try {
      await api.saveSettings({ [key]: value });
      setDrafts((d) => ({ ...d, [key]: "" }));
      await refresh();
    } catch (err) {
      alert(String(err));
    } finally {
      setBusyKey(null);
    }
  }

  async function clear(key) {
    setBusyKey(key);
    try {
      await api.clearSetting(key);
      await refresh();
    } finally {
      setBusyKey(null);
    }
  }

  async function test(key) {
    setBusyKey(key);
    try {
      const result = await api.testSetting(key);
      setTestResults((r) => ({ ...r, [key]: result }));
    } finally {
      setBusyKey(null);
    }
  }

  if (error) return <p style={{ color: "var(--accent-red)" }}>{error}</p>;
  if (!groups) return <p style={{ color: "var(--text-dim)" }}>Loading settings...</p>;

  return (
    <div>
      <p className="hud-subtitle" style={{ marginBottom: 16 }}>
        Every credential the system uses, all connected/disconnected status at a glance. Values are
        encrypted at rest and never shown back in full — only a masked preview. Leaving a field blank
        and not saving keeps whatever's already configured (database value, or a host env var as
        fallback).
      </p>

      {Object.entries(groups).map(([groupName, items]) => (
        <div key={groupName} className="panel" style={{ marginBottom: 14 }}>
          <div className="settings-group-title">{groupName}</div>
          {items.map((item) => (
            <SettingRow
              key={item.key}
              item={item}
              draft={drafts[item.key] || ""}
              onDraftChange={(v) => setDrafts((d) => ({ ...d, [item.key]: v }))}
              onSave={() => save(item.key)}
              onClear={() => clear(item.key)}
              onTest={() => test(item.key)}
              busy={busyKey === item.key}
              testResult={testResults[item.key]}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function SettingRow({ item, draft, onDraftChange, onSave, onClear, onTest, busy, testResult }) {
  return (
    <div className="settings-row">
      <label>{item.label}</label>
      <StatusPill item={item} testResult={testResult} />
      <input
        type={item.secret ? "password" : "text"}
        placeholder={item.set ? item.maskedValue || "set" : item.placeholder || "not set"}
        value={draft}
        onChange={(e) => onDraftChange(e.target.value)}
      />
      <button className="btn" disabled={busy || !draft} onClick={onSave}>
        Save
      </button>
      {item.set && (
        <button className="btn danger" disabled={busy} onClick={onClear}>
          Clear
        </button>
      )}
      {item.testable && item.set && (
        <button className="btn" disabled={busy} onClick={onTest}>
          Test
        </button>
      )}
    </div>
  );
}

function StatusPill({ item, testResult }) {
  if (testResult) {
    return <span className={`pill ${testResult.ok ? "ok" : "bad"}`}>{testResult.ok ? "Connected" : "Error"}</span>;
  }
  if (!item.set) return <span className="pill">Disconnected</span>;
  if (item.source === "environment") return <span className="pill warn">Env var</span>;
  return <span className="pill ok">Configured</span>;
}
