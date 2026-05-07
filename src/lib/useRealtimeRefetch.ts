"use client";

import { useEffect, useRef } from "react";
import { supabase } from "./supabaseClient";

type RealtimeFilter = {
  table: string;
  filter?: string;
};

// Subscribe to Postgres changes on one or more tables and call onChange when
// any of them fire. Re-subscribes when `tables` content changes. Pass a
// stable refetch via useCallback in the parent so this hook doesn't churn
// the subscription on every render.
export function useRealtimeRefetch(
  tables: RealtimeFilter[],
  onChange: () => void,
  channelName?: string,
) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const key = tables.map((t) => `${t.table}:${t.filter ?? ""}`).join("|");

  useEffect(() => {
    if (tables.length === 0) return;
    const name = channelName ?? `lm-${key}`;
    const channel = supabase.channel(name);

    tables.forEach(({ table, filter }) => {
      channel.on(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        "postgres_changes" as any,
        {
          event: "*",
          schema: "public",
          table,
          ...(filter ? { filter } : {}),
        },
        () => onChangeRef.current(),
      );
    });

    channel.subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, channelName]);
}
