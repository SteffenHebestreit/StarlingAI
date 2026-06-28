/**
 * Built-in tool registration barrel.
 *
 * Every built-in tool registers itself as a side effect of being imported
 * (`registerTool(...)` at module top level). This barrel is the single place
 * that pulls them all in, so any entry point that runs agents — the gateway
 * (src/index.ts) AND the offline agent/scene evaluation harnesses — gets the
 * full tool surface. Before this existed, the eval CLI ran agents with an
 * incomplete registry and tools like write_file/generate_document came back
 * "not registered", silently invalidating reliability runs.
 *
 * Keep this list the authoritative source; do not re-list these imports in
 * individual entry points.
 */
import "./filesystem.js";
import "./shell.js";
import "./ssh.js";
import "./ssh-upload.js";
import "./ssh-download.js";
import "./service-check.js";
import "./ansible.js";
import "./ansible-task.js";
import "./proxmox.js";
import "./terraform.js";
import "./kubernetes.js";
import "./prometheus.js";
import "./grafana.js";
import "./github.js";
import "./accessibility.js";
import "./credentials.js";
import "./sub-agent.js";
import "./federation.js";
import "./workflow-catalog.js";
import "./skills.js";
import "./session-search.js";
import "./user-model.js";
import "./tool-pipeline.js";
import "./memory.js";
import "./turn-plan-tool.js";
import "./recall-context.js";
import "./workspace-search.js";
import "./web.js";
import "./multimodal.js";
import "./document-output.js";
import "./website.js";
import "./serve-app.js";
import "./extractors.js";
import "./artifact-emitters.js";
import "./office-output.js";
import "./bundle-zip.js";
import "./pentest.js";
import "./computer-use.js";
import "./telegram.js";
import "./cron.js";
import "./schedule.js";
import "./http-request.js";
import "./git.js";
import "./messaging.js";
import "./ask-user.js";
import "./browser-assist.js";
import "./run-test-suite.js";
import "./log-stream.js";
import "./inline-utils.js";
import "./mail.js";
import "./calendar.js";
import "./contacts.js";
import "./agent-datastore.js";
import "./tool-develop.js";
import "./self-improve-tools.js";
import "./swarm-authoring-tools.js";
import "./graph.js";
import "./timeseries.js";
import "./research-scratch.js";
import "./rag.js";
import "./documents.js";
import "./sql.js";
import "./spreadsheet.js";
import "./pdf-forms.js";
import "./data-feeds/index.js";
