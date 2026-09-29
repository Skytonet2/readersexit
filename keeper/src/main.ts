// One image, two services: ROLE=keeper (default) fills orders, ROLE=indexer serves the API.

if (process.env.ROLE === "indexer") {
  await import("./indexer/index");
} else {
  await import("./index");
}

export {};
