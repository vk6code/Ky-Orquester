import type { RegistryResponse } from "@orquester/api";
import { useAppStore } from "../store/app";

/** Live registry (shells/agents/ides/…) from the store; updated via events. */
export function useRegistry(): RegistryResponse {
  return useAppStore((s) => s.registry);
}
