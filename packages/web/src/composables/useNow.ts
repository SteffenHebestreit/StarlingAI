import { onBeforeUnmount, onMounted, ref, type Ref } from "vue";

/** The current time in epoch ms, ticking while the component is mounted — for countdowns. */
export function useNow(intervalMs = 1000): Ref<number> {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | undefined;
  onMounted(() => {
    timer = setInterval(() => { now.value = Date.now(); }, intervalMs);
  });
  onBeforeUnmount(() => {
    if (timer) clearInterval(timer);
  });
  return now;
}
