window.__ModuleLoader__.load({
	id: "dsh-session-export",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const clientStore = require("@deepseek-ai/dsh-client-store");
		const primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		const h = react.createElement;

		/** Browser-relative form of the host plan route. */
		const PLAN_ROUTE = "api/session.transcript.plan";
		/** Browser-relative form of the host render route. */
		const RENDER_ROUTE = "api/session.transcript";
		/** Locale namespace owned by this plugin. */
		const NS = "sessionTranscript";
		/** Default truncation budget for bulky tool bodies. */
		const DEFAULT_TOOL_RESULT_CHARS = 20000;
		/** Turn filter visibility threshold. */
		const TURN_FILTER_THRESHOLD = 50;

		/**
		 * Describe one caught value.
		 * @param error - the caught value.
		 * @returns the message text.
		 */
		function messageOf(error) {
			return error instanceof Error ? error.message : String(error);
		}

		/**
		 * Hand a produced blob to the browser download manager.
		 * @param blob - the artifact bytes.
		 * @param filename - browser download filename.
		 */
		function saveBlob(blob, filename) {
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = filename;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			setTimeout(() => {
				URL.revokeObjectURL(url);
			}, 1000);
		}

		/**
		 * Read the host's chosen filename, falling back to a local convention.
		 * @param response - the render response.
		 * @param sessionId - the source session id.
		 * @param format - the exported format.
		 * @returns the filename.
		 */
		function filenameFromResponse(response, sessionId, format) {
			const header = typeof response.headers?.get === "function" ? response.headers.get("content-disposition") || "" : "";
			const match = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
			if (match !== null && match[1].length > 0) return match[1];
			return `dsh-session-${String(sessionId).replace(/[^A-Za-z0-9_-]/g, "_")}.${format}`;
		}

		/**
		 * Turn one failed response into an operator-readable message.
		 * @param response - the failed response.
		 * @returns the message.
		 */
		async function failureText(response) {
			let text = "";
			try {
				text = await response.text();
			} catch {
				return `HTTP ${response.status}`;
			}
			if (text.length === 0) return `HTTP ${response.status}`;
			try {
				const parsed = JSON.parse(text);
				const message = parsed?.error?.message;
				if (typeof message === "string" && message.length > 0) return message;
			} catch {
				// A non-JSON failure body is reported verbatim below.
			}
			return `HTTP ${response.status}: ${text.slice(0, 300)}`;
		}

		/** One freshly opened per-session dialog entry. */
		function blankEntry() {
			return {
				open: false,
				phase: "closed",
				plan: null,
				planError: null,
				error: null,
				format: "md",
				turns: null,
				includePreamble: true,
				sections: null,
				options: {
					maxToolResultChars: DEFAULT_TOOL_RESULT_CHARS,
					embedImages: true,
					collapseThinking: true
				}
			};
		}

		/** Selected turn numbers for one entry, expanded against its plan. */
		function selectedTurnsOf(entry, plan) {
			if (plan === null) return [];
			const all = plan.turns.map((turn) => turn.turn);
			// A missing list means "all turns"; anything else malformed degrades to the same.
			if (!Array.isArray(entry.turns)) return all;
			return all.filter((value) => entry.turns.includes(value));
		}

		/**
		 * Build one row label whose middle prompt preview is the only part that
		 * clips: the leading name and the trailing event count are `flex:none`, so
		 * they survive any ellipsis. The primitive renders `label` as the content of
		 * its own `<span>`, so a node is accepted exactly like a plain string.
		 * @param t - the namespace translator.
		 * @param lead - the localized leading text.
		 * @param prompt - the localized prompt preview, or `null` for a row without one.
		 * @param count - the localized event-count text.
		 * @returns the label node plus its complete plain text (tooltip and a11y name).
		 */
		function turnRowLabel(t, lead, prompt, count) {
			const parts = [lead];
			const spans = [h("span", { className: css.rowLead, key: "lead" }, lead)];
			if (prompt !== null) {
				parts.push(prompt);
				spans.push(h("span", { className: css.rowSep, key: "sep-prompt" }, "·"));
				spans.push(h("span", { className: css.rowPrompt, key: "prompt" }, prompt));
			}
			parts.push(count);
			spans.push(h("span", { className: css.rowSep, key: "sep-count" }, "·"));
			spans.push(h("span", { className: css.rowCount, key: "count" }, count));
			return {
				text: parts.join(" · "),
				node: h("span", { className: css.rowText }, ...spans)
			};
		}

		/**
		 * Owns one session's export dialog state and its in-flight requests.
		 *
		 * The controller is transport-agnostic (`fetcher`/`save` are injected),
		 * which is what makes it exercisable without a browser.
		 * @param options - optional `fetcher`, `save`, and `languageOf` overrides.
		 * @returns the controller.
		 */
		function createController(options = {}) {
			const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
			const save = options.save ?? saveBlob;
			const languageOf = options.languageOf ?? (() => "zh");
			const store = clientStore.createSnapshotStore({ bySession: {} });
			const active = new Map();
			const pending = new Set();
			let disposed = false;

			/**
			 * Remember one in-flight operation so `dispose` can reach quiescence.
			 * @param operation - the running promise.
			 * @returns the same promise.
			 */
			function track(operation) {
				let tracked;
				tracked = operation.catch(() => undefined).finally(() => {
					pending.delete(tracked);
				});
				pending.add(tracked);
				return operation;
			}

			/**
			 * Mutate one session's entry through the snapshot store.
			 * @param sessionId - the session id.
			 * @param mutate - draft mutator.
			 */
			function publish(sessionId, mutate) {
				const key = String(sessionId);
				store.update((state) => {
					const current = state.bySession[key] ?? blankEntry();
					mutate(current);
					state.bySession[key] = current;
				});
			}

			/** @param sessionId - the session id. @returns the current entry. */
			function entryOf(sessionId) {
				return store.getSnapshot().bySession[String(sessionId)];
			}

			/**
			 * Drop a settled success or failure banner once the selection moves on.
			 * An in-flight request keeps its own phase.
			 * @param entry - the draft entry.
			 */
			function settle(entry) {
				if (entry.phase === "rendering" || entry.phase === "plan") return;
				entry.phase = "idle";
				entry.error = null;
			}

			/**
			 * Open the dialog and load the session's plan.
			 * @param sessionId - the session to export.
			 * @returns the tracked operation.
			 */
			function open(sessionId) {
				return track(runOpen(sessionId));
			}

			/**
			 * Load one session's plan into its dialog entry.
			 * @param sessionId - the session to export.
			 */
			async function runOpen(sessionId) {
				const key = String(sessionId);
				active.get(key)?.abort();
				const abort = new AbortController();
				active.set(key, abort);
				publish(key, (entry) => {
					entry.open = true;
					entry.phase = "plan";
					entry.planError = null;
					entry.error = null;
				});
				try {
					const response = await fetcher(`${PLAN_ROUTE}?${new URLSearchParams({ sessionId: key }).toString()}`, {
						method: "GET",
						signal: abort.signal
					});
					if (!response.ok) throw new Error(await failureText(response));
					const plan = await response.json();
					if (disposed || abort.signal.aborted) return;
					publish(key, (entry) => {
						entry.plan = plan;
						entry.phase = "idle";
						entry.turns = null;
						entry.includePreamble = true;
						entry.sections = { ...plan.sectionDefaults };
						entry.options = {
							...entry.options,
							maxToolResultChars: plan.limits.maxToolResultChars
						};
						entry.planError = null;
						entry.error = null;
					});
				} catch (error) {
					if (disposed || abort.signal.aborted) return;
					const message = messageOf(error);
					publish(key, (entry) => {
						entry.phase = "error";
						entry.planError = message;
					});
				} finally {
					if (active.get(key) === abort) active.delete(key);
				}
			}

			/**
			 * Close one session's dialog without cancelling an in-flight request.
			 * @param sessionId - the session whose dialog closes.
			 */
			function close(sessionId) {
				publish(sessionId, (entry) => {
					entry.open = false;
					if (entry.phase === "done") entry.phase = "idle";
				});
			}

			/**
			 * Render and download one session's artifact.
			 * @param sessionId - the session to export.
			 * @returns the tracked operation.
			 */
			function render(sessionId) {
				return track(runRender(sessionId));
			}

			/**
			 * Build, request, and save one session's artifact.
			 * @param sessionId - the session to export.
			 */
			async function runRender(sessionId) {
				const key = String(sessionId);
				const entry = entryOf(key);
				if (disposed || entry === undefined || entry.plan === null) return;
				const body = JSON.stringify({
					sessionId: key,
					format: entry.format,
					turns: entry.turns,
					includePreamble: entry.includePreamble,
					sections: entry.sections,
					options: {
						...entry.options,
						language: languageOf()
					}
				});
				active.get(key)?.abort();
				const abort = new AbortController();
				active.set(key, abort);
				publish(key, (current) => {
					current.phase = "rendering";
					current.error = null;
				});
				try {
					const response = await fetcher(RENDER_ROUTE, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body,
						signal: abort.signal
					});
					if (!response.ok) throw new Error(await failureText(response));
					const blob = await response.blob();
					if (disposed || abort.signal.aborted) return;
					save(blob, filenameFromResponse(response, key, entry.format));
					publish(key, (current) => {
						current.phase = "done";
						current.error = null;
					});
				} catch (error) {
					if (disposed || abort.signal.aborted) return;
					const message = messageOf(error);
					publish(key, (current) => {
						current.phase = "error";
						current.error = message;
					});
				} finally {
					if (active.get(key) === abort) active.delete(key);
				}
			}

			/**
			 * Close every dialog and reach quiescence.
			 * @returns after every active request settles.
			 */
			async function dispose() {
				disposed = true;
				for (const abort of [...active.values()]) abort.abort();
				await Promise.allSettled([...pending]);
			}

			return {
				store,
				open,
				close,
				render,
				dispose,
				entryOf,
				selectedTurnsOf,
				setFormat: (sessionId, format) => {
					publish(sessionId, (entry) => {
						entry.format = format;
						settle(entry);
					});
				},
				setOption: (sessionId, key, value) => {
					publish(sessionId, (entry) => {
						entry.options = { ...entry.options, [key]: value };
						settle(entry);
					});
				},
				togglePreamble: (sessionId, next) => {
					publish(sessionId, (entry) => {
						entry.includePreamble = next;
						settle(entry);
					});
				},
				toggleSection: (sessionId, id, next) => {
					publish(sessionId, (entry) => {
						if (entry.sections === null) return;
						entry.sections = { ...entry.sections, [id]: next };
						settle(entry);
					});
				},
				resetSections: (sessionId) => {
					publish(sessionId, (entry) => {
						if (entry.plan === null) return;
						entry.sections = { ...entry.plan.sectionDefaults };
						settle(entry);
					});
				},
				selectAllTurns: (sessionId, all) => {
					publish(sessionId, (entry) => {
						entry.turns = all ? null : [];
						settle(entry);
					});
				},
				toggleTurn: (sessionId, turnNumber, next) => {
					publish(sessionId, (entry) => {
						if (entry.plan === null) return;
						const every = entry.plan.turns.map((turn) => turn.turn);
						const current = entry.turns === null ? every.slice() : entry.turns.slice();
						const index = current.indexOf(turnNumber);
						if (next === true && index < 0) current.push(turnNumber);
						if (next === false && index >= 0) current.splice(index, 1);
						const retained = every.filter((value) => current.includes(value));
						entry.turns = retained.length === every.length ? null : retained;
						settle(entry);
					});
				}
			};
		}

		/**
		 * Sum section counts over the currently selected turns and preamble.
		 * @param entry - the dialog entry.
		 * @param plan - the loaded plan.
		 * @returns a section-count map.
		 */
		function sectionTotalsOf(entry, plan) {
			const totals = {};
			const selected = selectedTurnsOf(entry, plan);
			for (const turn of plan.turns) {
				if (!selected.includes(turn.turn)) continue;
				for (const [id, value] of Object.entries(turn.counts ?? {})) totals[id] = (totals[id] ?? 0) + value;
			}
			if (entry.includePreamble && plan.preamble !== null && plan.preamble !== undefined) {
				for (const [id, value] of Object.entries(plan.preamble.counts ?? {})) totals[id] = (totals[id] ?? 0) + value;
			}
			return totals;
		}

		/** Shared dialog body for the header action. */
		function SessionTranscriptExportDialog(props) {
			const sessionId = props.sessionId;
			const controller = props.controller;
			const t = props.t;
			const entry = props.useSessionExport((state) => state.bySession[String(sessionId)]);
			const [filter, setFilter] = react.useState("");
			const plan = entry?.plan ?? null;
			const phase = entry?.phase ?? "closed";
			const open = entry?.open === true;
			const loading = phase === "plan" && plan === null;
			const fatal = phase === "error" && plan === null;
			const busy = phase === "rendering";
			const selectedTurns = entry !== null && entry !== undefined && plan !== null ? selectedTurnsOf(entry, plan) : [];
			const exportable = selectedTurns.length > 0 && plan !== null;
			const totals = plan !== null && entry !== null && entry !== undefined ? sectionTotalsOf(entry, plan) : {};
			const turnLimit = plan?.limits?.maxTurns ?? 2000;
			const overLimit = selectedTurns.length > turnLimit;

			const close = () => {
				controller.close(sessionId);
			};
			const title = fatal ? t("dialog.errorTitle") : t("dialog.title");
			const description = t("dialog.description");

			const formatControl = h(primitives.SegmentedControl, {
				id: "session-export-format",
				value: entry?.format ?? "md",
				label: t("format.label"),
				disabled: busy,
				options: [
					{ value: "md", label: t("format.md") },
					{ value: "html", label: t("format.html") },
					{ value: "json", label: t("format.json") }
				],
				onChange: (next) => {
					controller.setFormat(sessionId, next);
				}
			});

			const visibleTurns = plan === null ? [] : plan.turns.filter((turn) => {
				if (filter.length === 0) return true;
				const needle = filter.trim().toLowerCase();
				if (needle.length === 0) return true;
				return String(turn.turn).includes(needle) || turn.prompt.toLowerCase().includes(needle);
			});

			const turnRows = [];
			if (plan !== null && plan.preamble !== null && plan.preamble !== undefined) {
				const preamble = turnRowLabel(t, t("turns.preamble"), null, t("turns.count", { n: plan.preamble.eventCount }));
				turnRows.push(
					h("div", { className: css.row, key: "preamble" },
						h(primitives.Checkbox, {
							checked: entry.includePreamble === true,
							disabled: busy,
							className: css.rowLabel,
							title: preamble.text,
							label: preamble.node,
							onChange: (next) => {
								controller.togglePreamble(sessionId, next);
							}
						})
					)
				);
			}
			for (const turn of visibleTurns) {
				const selected = entry.turns;
				const checked = !Array.isArray(selected) || selected.includes(turn.turn);
				const label = turnRowLabel(
					t,
					t("turns.turn", { n: turn.turn }),
					turn.prompt.length > 0 ? turn.prompt : t("turns.noPrompt"),
					t("turns.count", { n: turn.eventCount })
				);
				// The prompt is the only clipped part (see .dshSessionExportRowText), so the
				// tooltip carries the complete text plus the response preview.
				const hover = turn.response.length > 0 ? `${label.text}\n${turn.response}` : label.text;
				turnRows.push(
					h("div", { className: css.row, key: `turn-${turn.turn}` },
						h(primitives.Checkbox, {
							checked,
							disabled: busy,
							className: css.rowLabel,
							title: hover,
							label: label.node,
							onChange: (next) => {
								controller.toggleTurn(sessionId, turn.turn, next);
							}
						})
					)
				);
			}

			const sectionRows = plan === null ? [] : plan.sectionOrder.map((id) => {
				const count = totals[id] ?? 0;
				const checked = entry?.sections?.[id] === true;
				return h("div", { className: css.cell, key: id },
					h(primitives.Checkbox, {
						checked,
						disabled: busy || (count === 0 && !checked),
						label: count === 0 ? t(`section.${id}`) : `${t(`section.${id}`)} · ${count}`,
						onChange: (next) => {
							controller.toggleSection(sessionId, id, next);
						}
					})
				);
			});

			const advanced = h("details", { className: css.advanced },
				h("summary", null, t("advanced.title")),
				h("div", { className: css.option },
					h("span", { className: css.optionLabel }, t("advanced.maxToolResultChars")),
					h(primitives.Input, {
						type: "number",
						min: 200,
						step: 1000,
						className: css.optionInput,
						defaultValue: String(entry?.options?.maxToolResultChars ?? DEFAULT_TOOL_RESULT_CHARS),
						disabled: busy,
						onChange: (event) => {
							const parsed = Number(event.target.value);
							if (Number.isFinite(parsed) && parsed >= 200) {
								controller.setOption(sessionId, "maxToolResultChars", Math.round(parsed));
							}
						}
					})
				),
				h("div", { className: css.option },
					h("span", { className: css.optionLabel }, t("advanced.embedImages")),
					h(primitives.Switch, {
						checked: entry?.options?.embedImages !== false,
						disabled: busy,
						label: t("advanced.embedImages"),
						onChange: (next) => {
							controller.setOption(sessionId, "embedImages", next);
						}
					})
				),
				h("div", { className: css.option },
					h("span", { className: css.optionLabel }, t("advanced.collapseThinking")),
					h(primitives.Switch, {
						checked: entry?.options?.collapseThinking !== false,
						disabled: busy,
						label: t("advanced.collapseThinking"),
						onChange: (next) => {
							controller.setOption(sessionId, "collapseThinking", next);
						}
					})
				)
			);

			const body = loading
				? h("p", { className: css.note }, t("dialog.loading"))
				: fatal
					? h("div", null,
						h("p", { className: css.error }, entry?.planError ?? t("dialog.errorTitle")),
						h(primitives.Button, {
							variant: "primary",
							onClick: () => {
								controller.open(sessionId);
							},
							children: t("dialog.retry")
						})
					)
					: h("div", null,
						phase === "done" ? h("p", { className: css.ok }, t("dialog.downloadStarted")) : null,
						phase === "error" ? h("p", { className: css.error }, entry?.error ?? t("dialog.renderFailed")) : null,
						h("div", { className: css.field },
							h("div", { className: css.fieldLabel }, t("format.label")),
							formatControl
						),
						overLimit ? h("p", { className: css.warn }, t("dialog.turnLimit", { limit: turnLimit })) : null,
						h("div", { className: css.field },
							h("div", { className: css.fieldHeader },
								h("div", { className: css.fieldLabel }, t("turns.title")),
								h("div", { className: css.fieldActions },
									h("button", {
										type: "button",
										className: css.linkButton,
										disabled: busy,
										onClick: () => {
											controller.selectAllTurns(sessionId, true);
										},
										children: t("turns.all")
									}),
									h("button", {
										type: "button",
										className: css.linkButton,
										disabled: busy,
										onClick: () => {
											controller.selectAllTurns(sessionId, false);
										},
										children: t("turns.none")
									}),
									h("span", { className: css.count }, t("turns.selected", { n: selectedTurns.length, total: plan?.turns?.length ?? 0 }))
								)
							),
							(plan?.turns?.length ?? 0) > TURN_FILTER_THRESHOLD
								? h(primitives.Input, {
									className: css.filter,
									placeholder: t("turns.filterPlaceholder"),
									value: filter,
									disabled: busy,
									onChange: (event) => {
										setFilter(event.target.value);
									}
								})
								: null,
							turnRows.length > 0
								? h("div", { className: css.list }, turnRows)
								: h("p", { className: css.note }, t("turns.empty"))
						),
						h("div", { className: css.field },
							h("div", { className: css.fieldHeader },
								h("div", { className: css.fieldLabel }, t("sections.title")),
								h("div", { className: css.fieldActions },
									h("button", {
										type: "button",
										className: css.linkButton,
										disabled: busy,
										onClick: () => {
											controller.resetSections(sessionId);
										},
										children: t("sections.reset")
									})
								)
							),
							h("div", { className: css.grid }, sectionRows)
						),
						advanced
					);

			// The dialog stays a reusable export panel: a finished download reports itself
			// with a status line, never by replacing the export action with a one-shot close.
			const footer = h(react.Fragment, null,
				h(primitives.Button, { variant: "ghost", onClick: close, disabled: busy, children: t("dialog.cancel") }),
				h(primitives.Button, {
					variant: "primary",
					disabled: busy || !exportable || overLimit,
					onClick: () => {
						controller.render(sessionId);
					},
					children: phase === "rendering" ? t("dialog.rendering") : t("dialog.export")
				})
			);

			return h(primitives.Modal, {
				open,
				onClose: close,
				title,
				description,
				closeLabel: t("dialog.close"),
				className: css.dialog,
				contentClassName: css.dialogContent,
				footer
			}, body);
		}

		/** Session-header entry point for the transcript export dialog. */
		function SessionTranscriptExportAction(props) {
			const sessionId = props.sessionId;
			const controller = props.controller;
			const t = props.t;
			const entry = props.useSessionExport((state) => state.bySession[String(sessionId)]);
			const busy = entry !== undefined && (entry.phase === "plan" || entry.phase === "rendering");
			return h(react.Fragment, null,
				h(primitives.Button, {
					size: "sm",
					className: css.trigger,
					"aria-label": t("action.open"),
					"aria-busy": busy,
					title: t("action.open"),
					onClick: () => {
						controller.open(sessionId);
					}
				}, h(primitives.IconDownloadOutlineRegular, {})),
				h(SessionTranscriptExportDialog, {
					sessionId,
					controller,
					useSessionExport: props.useSessionExport,
					t
				})
			);
		}

		const css = {
			dialog: "dshSessionExportDialog",
			dialogContent: "dshSessionExportDialogContent",
			trigger: "dshSessionExportTrigger",
			field: "dshSessionExportField",
			fieldHeader: "dshSessionExportFieldHeader",
			fieldLabel: "dshSessionExportFieldLabel",
			fieldActions: "dshSessionExportFieldActions",
			linkButton: "dshSessionExportLink",
			count: "dshSessionExportCount",
			filter: "dshSessionExportFilter",
			list: "dshSessionExportList",
			row: "dshSessionExportRow",
			rowLabel: "dshSessionExportRowLabel",
			rowText: "dshSessionExportRowText",
			rowLead: "dshSessionExportRowLead",
			rowSep: "dshSessionExportRowSep",
			rowPrompt: "dshSessionExportRowPrompt",
			rowCount: "dshSessionExportRowCount",
			grid: "dshSessionExportGrid",
			cell: "dshSessionExportCell",
			advanced: "dshSessionExportAdvanced",
			option: "dshSessionExportOption",
			optionLabel: "dshSessionExportOptionLabel",
			optionInput: "dshSessionExportOptionInput",
			note: "dshSessionExportNote",
			warn: "dshSessionExportWarn",
			ok: "dshSessionExportOk",
			error: "dshSessionExportError"
		};

		const cssText = [
			// Card shell. The Modal primitive's own card rule is a single class
			// (`width: min(380px, 100%)`), so these overrides double their class to win on
			// specificity rather than relying on stylesheet order.
			".dshSessionExportDialog.dshSessionExportDialog{width:min(680px,100%);max-height:min(86vh,860px)}",
			".dshSessionExportDialogContent.dshSessionExportDialogContent{flex:1;min-height:0;overflow-y:auto}",
			".dshSessionExportTrigger{width:28px;padding:0;flex:none;color:var(--dsw-alias-label-secondary)}",
			".dshSessionExportTrigger svg{width:15px;height:15px}",
			".dshSessionExportField{margin:0 0 18px}",
			".dshSessionExportFieldHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 0 8px}",
			".dshSessionExportFieldLabel{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}",
			".dshSessionExportFieldActions{display:flex;align-items:center;gap:10px}",
			".dshSessionExportLink{background:none;border:0;padding:0;cursor:pointer;font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dshSessionExportLink:hover{color:var(--dsw-alias-label-primary)}",
			".dshSessionExportLink:disabled{opacity:.5;cursor:default}",
			".dshSessionExportCount{font-size:12px;color:var(--dsw-alias-label-secondary)}",
			".dshSessionExportFilter{margin:0 0 8px}",
			".dshSessionExportList{max-height:220px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px}",
			// One clipped line per turn, with the event count always readable. The chain that
			// makes it work: block row → full-width flex label → flex wrapper → flex text row,
			// each with min-width:0 so only the prompt element ever shrinks.
			".dshSessionExportRow{min-width:0;padding:2px 0}",
			".dshSessionExportRowLabel.dshSessionExportRowLabel{display:flex;width:100%;max-width:100%;min-width:0;overflow:hidden}",
			".dshSessionExportRowLabel.dshSessionExportRowLabel>span{display:flex;flex:1 1 auto;min-width:0}",
			".dshSessionExportRowText{display:flex;flex:1 1 auto;min-width:0;align-items:center;gap:6px}",
			".dshSessionExportRowLead{flex:0 0 auto;white-space:nowrap}",
			".dshSessionExportRowSep{flex:0 0 auto;color:var(--dsw-alias-label-tertiary)}",
			// The prompt absorbs every bit of the shrink; the count never does.
			".dshSessionExportRowPrompt{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}",
			".dshSessionExportRowCount{flex:0 0 auto;white-space:nowrap;font-variant-numeric:tabular-nums}",
			".dshSessionExportGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:4px 16px}",
			".dshSessionExportCell{padding:2px 0}",
			".dshSessionExportAdvanced{margin:8px 0 0;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:8px 10px}",
			".dshSessionExportAdvanced summary{cursor:pointer;font-size:13px;color:var(--dsw-alias-label-secondary)}",
			".dshSessionExportOption{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:10px 0 0}",
			".dshSessionExportOptionLabel{font-size:13px;color:var(--dsw-alias-label-primary)}",
			".dshSessionExportOptionInput{width:150px}",
			".dshSessionExportNote{font-size:13px;color:var(--dsw-alias-label-secondary);margin:6px 0}",
			".dshSessionExportWarn{font-size:13px;color:var(--dsw-alias-state-warn-primary);margin:0 0 12px}",
			".dshSessionExportOk{font-size:13px;color:var(--dsw-alias-state-success-primary);margin:0 0 12px}",
			".dshSessionExportError{font-size:13px;color:var(--dsw-alias-state-error-primary);margin:0 0 12px}"
		].join("");
		const tagId = "dsh-session-export/Dialog.css";
		if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(tagId)}]`) === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-export";
			tag.dataset.pluginCss = tagId;
			tag.textContent = cssText;
			document.head.appendChild(tag);
		}

		/** Simplified-Chinese dialog copy. */
		const zh = {
			"action.open": "导出会话",
			"dialog.title": "导出会话",
			"dialog.description": "选择要导出的轮次与事件类型，然后下载 Markdown、HTML 或 JSON。",
			"dialog.loading": "正在读取会话数据…",
			"dialog.errorTitle": "导出失败",
			"dialog.renderFailed": "导出失败，请调整选择后重试。",
			"dialog.downloadStarted": "已开始下载，可继续调整选择再次导出。",
			"dialog.retry": "重试",
			"dialog.export": "导出",
			"dialog.rendering": "导出中…",
			"dialog.cancel": "取消",
			"dialog.close": "关闭",
			"dialog.turnLimit": "选中的轮次超过上限（{limit}），请缩小范围。",
			"format.label": "格式",
			"format.md": "Markdown",
			"format.html": "HTML",
			"format.json": "JSON",
			"turns.title": "轮次",
			"turns.all": "全选",
			"turns.none": "全不选",
			"turns.selected": "已选 {n} / {total}",
			"turns.turn": "第 {n} 轮",
			"turns.count": "{n} 条事件",
			"turns.preamble": "会话前导",
			"turns.noPrompt": "（无提示词）",
			"turns.filterPlaceholder": "按轮号或提示词筛选",
			"turns.empty": "没有匹配的轮次。",
			"sections.title": "事件类型",
			"sections.reset": "恢复默认",
			"section.user": "用户消息",
			"section.context": "注入上下文",
			"section.assistant": "AI 回复",
			"section.thinking": "思考过程",
			"section.toolCalls": "工具调用",
			"section.toolResults": "工具结果",
			"section.images": "图片",
			"section.files": "文件附件",
			"section.usage": "Token 用量",
			"section.markers": "轮次/步骤标记",
			"section.attempts": "未完成的尝试",
			"section.stream": "原始流记录",
			"section.other": "其他事件",
			"advanced.title": "高级选项",
			"advanced.maxToolResultChars": "工具结果最大字符数",
			"advanced.embedImages": "HTML 内嵌图片",
			"advanced.collapseThinking": "折叠思考块"
		};

		/** English dialog copy. */
		const en = {
			"action.open": "Export session",
			"dialog.title": "Export session",
			"dialog.description": "Pick the turns and event types to include, then download Markdown, HTML, or JSON.",
			"dialog.loading": "Reading session data…",
			"dialog.errorTitle": "Export failed",
			"dialog.renderFailed": "The export failed; adjust the selection and try again.",
			"dialog.downloadStarted": "Download started — adjust the selection to export again.",
			"dialog.retry": "Retry",
			"dialog.export": "Export",
			"dialog.rendering": "Exporting…",
			"dialog.cancel": "Cancel",
			"dialog.close": "Close",
			"dialog.turnLimit": "The selection exceeds the {limit}-turn limit; narrow it down.",
			"format.label": "Format",
			"format.md": "Markdown",
			"format.html": "HTML",
			"format.json": "JSON",
			"turns.title": "Turns",
			"turns.all": "Select all",
			"turns.none": "Select none",
			"turns.selected": "{n} of {total} selected",
			"turns.turn": "Turn {n}",
			"turns.count": "{n} events",
			"turns.preamble": "Session preamble",
			"turns.noPrompt": "(no prompt)",
			"turns.filterPlaceholder": "Filter by turn number or prompt",
			"turns.empty": "No turn matches the filter.",
			"sections.title": "Event types",
			"sections.reset": "Reset to defaults",
			"section.user": "User messages",
			"section.context": "Injected context",
			"section.assistant": "Assistant messages",
			"section.thinking": "Thinking",
			"section.toolCalls": "Tool calls",
			"section.toolResults": "Tool results",
			"section.images": "Images",
			"section.files": "File attachments",
			"section.usage": "Token usage",
			"section.markers": "Turn/step markers",
			"section.attempts": "Incomplete attempts",
			"section.stream": "Raw stream records",
			"section.other": "Other events",
			"advanced.title": "Advanced",
			"advanced.maxToolResultChars": "Max tool-result characters",
			"advanced.embedImages": "Embed images in HTML",
			"advanced.collapseThinking": "Collapse thinking blocks"
		};

		/** Browser plugin body: dictionaries, controller, and the header action. */
		const inject = ["slots", "locale"];

		/**
		 * Provide the controller and mount the session-header export action.
		 * @param ctx - browser context carrying slots and locale services.
		 */
		function apply(ctx) {
			const controller = createController({
				languageOf: () => {
					try {
						const active = ctx.locale.getLocale()?.active;
						return typeof active === "string" && active.startsWith("zh") ? "zh" : "en";
					} catch {
						return "zh";
					}
				}
			});
			ctx.effect(() => async () => {
				await controller.dispose();
			}, "session-transcript-export: controller lifecycle");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-transcript-export: dictionaries");
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({
				name: "conversation.session.header.actions",
				id: "session-transcript-export",
				order: 40,
				locale: NS,
				inject: () => ({
					controller,
					hooks: { sessionExport: controller.store }
				})
			}, SessionTranscriptExportAction));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.__internals = {
			createController,
			SessionTranscriptExportAction,
			SessionTranscriptExportDialog,
			filenameFromResponse,
			sectionTotalsOf,
			selectedTurnsOf,
			css,
			cssText,
			zh,
			en
		};
		return module.exports;
	}
});
