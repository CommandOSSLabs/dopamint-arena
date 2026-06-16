// import "server-only";
"use client";
import {
  DynamicFieldInfo,
  EventId,
  SuiClient,
  SuiEvent,
  SuiEventFilter,
} from "@mysten/sui/client";

export async function queryAllDynamicFields({
  suiClient,
  parentId,
}: {
  suiClient: SuiClient;
  parentId: string;
}) {
  let nextCursor: string | null | undefined = undefined;
  let fields: DynamicFieldInfo[] = [];
  let hasNextPage = true;
  while (hasNextPage) {
    const results = await suiClient.getDynamicFields({
      parentId,
      limit: 50,
      cursor: nextCursor,
    });
    fields = fields.concat(results.data);
    hasNextPage = results.hasNextPage;
    nextCursor = results.nextCursor;
  }
  console.log({ fields });
  return [];
}

export async function queryAllEvents({
  suiClient,
  query,
}: {
  suiClient: SuiClient;
  query: SuiEventFilter;
}) {
  let nextCursor: EventId | null | undefined = undefined;
  let events: SuiEvent[] = [];
  let hasNextPage = true;
  while (hasNextPage) {
    const results = await suiClient.queryEvents({
      query,
      limit: 50,
    });
    events = events.concat(results.data);
    hasNextPage = results.hasNextPage;
    nextCursor = results.nextCursor;
  }
  return events;
}
