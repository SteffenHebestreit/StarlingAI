import { createApp } from "vue";
import { createPinia } from "pinia";
import router from "./router";
import App from "./App.vue";
import "./style.css";

const CHUNK_RELOAD_KEY = "starlingai:chunk-reload-target";

function isDynamicImportFailure(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error ?? "");
	return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message);
}

router.onError((error, to) => {
	if (!isDynamicImportFailure(error)) {
		console.error(error);
		return;
	}

	const target = to.fullPath || window.location.pathname + window.location.search + window.location.hash;
	const previousTarget = window.sessionStorage.getItem(CHUNK_RELOAD_KEY);
	if (previousTarget === target) {
		window.sessionStorage.removeItem(CHUNK_RELOAD_KEY);
		console.error(error);
		return;
	}

	window.sessionStorage.setItem(CHUNK_RELOAD_KEY, target);
	window.location.assign(target);
});

router.afterEach(() => {
	window.sessionStorage.removeItem(CHUNK_RELOAD_KEY);
});

const app = createApp(App);
app.use(createPinia());
app.use(router);
app.mount("#app");
