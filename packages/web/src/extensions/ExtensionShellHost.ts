/**
 * Mounts the extensions' shell components (`shellComponents` in registry.ts) inside the app
 * shell: App.vue renders this host once, so each component stays mounted across navigation,
 * whatever page is open, for as long as the shell is on screen and the same user is signed in.
 *
 * A render function rather than an SFC, so the web package's node-environment tests can mount it.
 */
import { Fragment, defineComponent, h, onErrorCaptured, onMounted, ref, type PropType } from "vue";
import type { WebExtensionShellComponent } from "./shell";

/**
 * Renders its slot only once it has itself been mounted, one scheduler tick later.
 *
 * That takes the slot's first mount out of the shell's synchronous `app.mount()` and puts it in a
 * scheduler job this component owns. There Vue hands an error from every step of the mount to the
 * boundary above — the DOM step included (an element that cannot be created, an attribute that
 * cannot be set). During the shell's own first mount Vue does not: such an error escapes
 * `app.mount()` and the page stays blank. On the server nothing is mounted, so the slot is left
 * to the client (which also keeps hydration consistent).
 */
const MountAfterParent = defineComponent({
  name: "ExtensionShellMountAfterParent",
  setup(_props, { slots }) {
    const mounted = ref(false);
    onMounted(() => {
      mounted.value = true;
    });
    return () => (mounted.value ? slots.default?.() : null);
  },
});

/**
 * Keeps an error thrown in an extension's shell component away from the shell and from the other
 * extensions' components: whether it comes from the component's setup, its render, its first
 * mount, a lifecycle hook, a watcher, an event handler or the loading of an async component, it is
 * logged with the extension's name and goes no further — not even to `app.config.errorHandler`,
 * so the shell does not depend on one being set (without one, Vue's development build rethrows,
 * and the throw would tear down the shell's render).
 *
 * The failing component is not unmounted. Vue's own rule applies to it: a render that throws draws
 * nothing that time, and everything else in it keeps running — a watcher whose callback failed once
 * still fires on the next change.
 */
export const ExtensionShellBoundary = defineComponent({
  name: "ExtensionShellBoundary",
  props: {
    /** The contributing extension's name, for the log line. */
    extension: { type: String, required: true },
  },
  setup(props, { slots }) {
    onErrorCaptured((error, _instance, info) => {
      console.error(`[extensions] ${props.extension}: error in a shell component (${info}):`, error);
      return false;
    });
    // The slot goes one component down: Vue offers an error to the boundaries ABOVE the component
    // it happened in, so the deferred mount below must be a child of this one, not this one.
    return () => h(MountAfterParent, null, { default: () => slots.default?.() });
  },
});

/**
 * The extensions' shell components, each behind its own boundary, in the order given. Renders no
 * element of its own: every component draws (or does not draw) its own root.
 */
export default defineComponent({
  name: "ExtensionShellHost",
  props: {
    components: { type: Array as PropType<readonly WebExtensionShellComponent[]>, required: true },
    /**
     * Who is signed in ("" while nobody is). Whenever it changes, every component is unmounted and
     * mounted afresh, so nothing one user's session left in them — an alert list, a banner naming
     * someone — is still there for the next user, or over the sign-in dialog.
     */
    session: { type: String, required: true },
  },
  setup(props) {
    return () =>
      h(
        Fragment,
        { key: props.session },
        props.components.map(({ extension, component }, index) =>
          h(ExtensionShellBoundary, { key: index, extension }, () => h(component)),
        ),
      );
  },
});
