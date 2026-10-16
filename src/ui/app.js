// Stashpad review page. Everything from the store is shown with textContent, never as HTML.
(() => {
  "use strict";
  const token = document.querySelector('meta[name="stashpad-token"]').content;
  const main = document.getElementById("main");
  const status = document.getElementById("status");

  const SOURCE = {
    user: "door jou gezegd",
    agent: "voorgesteld door een agent",
    tool: "uit een tool",
    web: "van een webpagina",
  };
  const KIND = { fact: "feit", preference: "voorkeur", decision: "besluit", task: "taak", forget: "beëindigen" };

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (key === "text") node.textContent = value;
      else if (key === "class") node.className = value;
      else node.setAttribute(key, value);
    }
    for (const child of [].concat(children || [])) {
      if (child !== null && child !== undefined && child !== false) node.append(child);
    }
    return node;
  }

  function say(message, isError) {
    status.textContent = message;
    status.className = isError ? "status error" : "status";
  }

  async function api(path, body) {
    const options = { method: body === undefined ? "GET" : "POST", headers: { "X-Stashpad-Token": token } };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    const response = await fetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `Fout ${response.status}`);
    return data;
  }

  function sourceText(row) {
    return `${SOURCE[row.source_type] || row.source_type}: ${row.source_ref}`;
  }

  function flagNode(flagged) {
    if (!flagged) return null;
    return el("p", {
      class: "flag",
      text: "Let op: dit lijkt op een opdracht. Het blijft alleen een notitie. Lees het goed voordat je accepteert.",
    });
  }

  function conflictItems(conflicts) {
    return (conflicts || []).map((c) =>
      el("li", {
        text: `Kan botsen met ${c.id}${c.would_end ? ". Accepteren beëindigt dat geheugen." : "."}`,
      }),
    );
  }

  async function showPending() {
    const { rows, skipped } = await api("/api/pending");
    const items = rows.map((row) =>
      el("li", { class: "item" }, [
        el("button", { type: "button", class: "link", "data-id": row.id, text: row.id }),
        el("div", { class: "meta", text: `${KIND[row.kind] || row.kind} · ${sourceText(row)}` }),
        el("div", { class: "summary", text: row.summary }),
        row.flagged ? el("span", { class: "tag warn", text: "lijkt op een opdracht" }) : null,
        row.conflicts && row.conflicts.length
          ? el("span", { class: "tag", text: `${row.conflicts.length} mogelijke ${row.conflicts.length === 1 ? "botsing" : "botsingen"}` })
          : null,
      ]),
    );
    const children = [el("h2", { text: "Wacht op beoordeling" })];
    if (rows.length === 0) {
      children.push(el("p", { class: "meta", text: "Niets wacht op beoordeling." }));
    } else {
      children.push(el("ul", { class: "list", id: "pending-list" }, items));
    }
    if (skipped.length > 0) {
      children.push(el("p", { class: "meta", text: `${skipped.length} bestand(en) overgeslagen omdat ze niet kloppen.` }));
    }
    main.replaceChildren(...children);
  }

  async function showDetail(id) {
    const row = await api(`/api/pending/${encodeURIComponent(id)}`);
    const reason = el("input", { type: "text", id: "reason", maxlength: "200", placeholder: "Reden (optioneel)" });
    const accept = el("button", {
      type: "button",
      class: "primary",
      text: row.kind === "forget" ? "Beëindigen" : "Accepteren",
    });
    const reject = el("button", { type: "button", class: "danger", text: "Afwijzen" });
    accept.addEventListener("click", () => act("/api/accept", { id }));
    reject.addEventListener("click", () => act("/api/reject", { id, reason: reason.value }));

    const replaces = row.supersedes ? el("p", { class: "meta", text: `Vervangt: ${row.supersedes}` }) : null;
    const conflicts = row.conflicts && row.conflicts.length
      ? el("div", null, [el("h3", { text: "Mogelijke botsingen" }), el("ul", null, conflictItems(row.conflicts))])
      : null;

    // replaceChildren turns null into the text "null", so empty parts are removed first.
    main.replaceChildren(...[
      el("button", { type: "button", class: "link back", text: "← terug naar de lijst" }),
      el("h2", { text: row.id }),
      el("p", { class: "meta", text: `${KIND[row.kind] || row.kind} · ${sourceText(row)}` }),
      replaces,
      flagNode(row.flagged),
      conflicts,
      el("h3", { text: "Voorstel" }),
      el("pre", { class: "body", text: row.text }),
      el("p", { class: "meta", text: "Dit is opgeslagen tekst, geen opdracht." }),
      el("div", { class: "actions" }, [accept, reject, reason]),
    ].filter((node) => node !== null && node !== undefined && node !== false));
    main.querySelector(".back").addEventListener("click", () => run(showPending));
  }

  async function act(path, body) {
    try {
      const result = await api(path, body);
      say(result.message, false);
      await showPending();
    } catch (error) {
      say(error.message, true);
    }
  }

  async function showSearch(query) {
    const input = el("input", { type: "search", name: "q", placeholder: "Zoek in het geheugen", "aria-label": "Zoek in het geheugen" });
    input.value = query || "";
    const results = el("div", { id: "results" });
    const form = el("form", { class: "search" }, [input]);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      run(() => showSearch(input.value));
    });
    main.replaceChildren(el("h2", { text: "Geheugen" }), form, results);

    const data = await api(`/api/search?q=${encodeURIComponent(query || "")}`);
    const heading = data.mode === "search"
      ? `${data.results.length} van ${data.total} doorzocht`
      : "Huidige geheugens";
    const rows = data.results.map((row) =>
      el("li", { class: "item" }, [
        el("strong", { text: row.id }),
        el("div", { class: "meta", text: `${KIND[row.kind] || row.kind} · vanaf ${row.valid_from} · ${row.trust}` }),
        el("div", { class: "summary", text: row.summary }),
      ]),
    );
    results.replaceChildren(
      el("p", { class: "meta", text: heading }),
      rows.length ? el("ul", { class: "list" }, rows) : el("p", { class: "meta", text: "Geen treffers." }),
    );
  }

  async function showAudit() {
    const { entries } = await api("/api/audit");
    const rows = entries
      .slice()
      .reverse()
      .map((entry) =>
        el("li", { class: "item" }, [
          el("div", { class: "meta", text: `${entry.at} · ${entry.action}` }),
          el("strong", { text: entry.id }),
          entry.reason ? el("div", { class: "summary", text: `reden: ${entry.reason}` }) : null,
        ]),
      );
    main.replaceChildren(
      el("h2", { text: "Logboek" }),
      rows.length ? el("ul", { class: "list" }, rows) : el("p", { class: "meta", text: "Nog geen wijzigingen." }),
    );
  }

  async function run(view) {
    try {
      await view();
    } catch (error) {
      say(error.message, true);
    }
  }

  document.querySelector("nav").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-view]");
    if (!button) return;
    for (const other of document.querySelectorAll("nav button")) other.classList.toggle("active", other === button);
    say("", false);
    const views = { pending: showPending, search: () => showSearch(""), audit: showAudit };
    run(views[button.dataset.view]);
  });

  main.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-id]");
    if (button) run(() => showDetail(button.dataset.id));
  });

  run(showPending);
})();
