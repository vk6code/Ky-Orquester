import type { RegistryResponse } from "@orquester/api";
import { useApi } from "../context/orquester-context";
import { useAsyncResource, type AsyncResource } from "./use-async-resource";

const EMPTY: RegistryResponse = {
  shells: [],
  agents: [],
  ides: [],
  fileExplorers: [],
  browsers: []
};

/** The daemon's catalog of launchable shells and agents (with PATH detection). */
export function useRegistry(): AsyncResource<RegistryResponse> {
  const api = useApi();
  return useAsyncResource<RegistryResponse>((signal) => api.listRegistry(signal), EMPTY, [api]);
}
