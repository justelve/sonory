import { styleText } from "node:util";

interface HelpTopic {
  readonly name: string;
  readonly description: string;
  readonly arguments: readonly {
    readonly name: string;
    readonly description: string;
    readonly optional?: boolean;
  }[];
  readonly example: string;
  readonly sections?: readonly { readonly title: string; readonly lines: readonly string[] }[];
}

const topics: readonly HelpTopic[] = [
  {
    name: "providers",
    description: "List installed providers and their supported features.",
    arguments: [],
    example: "sonory providers",
  },
  {
    name: "auth",
    description: "Sign in to a music provider and save the account.",
    arguments: [
      {
        name: "provider",
        description: "Provider ID, such as deezer. Omit it to choose interactively.",
        optional: true,
      },
    ],
    example: "sonory auth deezer",
    sections: [
      {
        title: "Deezer sign-in",
        lines: [
          "ARL is the arl cookie from a signed-in Deezer browser session.",
          "Enter it when prompted. The value is masked.",
          'For scripts, send {"arl":"<your ARL>"} through standard input.',
        ],
      },
      {
        title: "Storage",
        lines: [
          "Credentials are saved in the OS credential store.",
          "Account names and defaults are saved in your user configuration directory.",
        ],
      },
    ],
  },
  {
    name: "search",
    description: "Search a provider's music catalog.",
    arguments: [
      {
        name: "provider",
        description: "Provider ID, such as deezer, or default to use your saved selection.",
      },
      { name: "query", description: "Search text. Put quotes around text containing spaces." },
    ],
    example: 'sonory search deezer "Daft Punk"',
    sections: [
      { title: "More results", lines: ["Use --cursor with the value shown after the results."] },
    ],
  },
  {
    name: "track",
    description: "Show details for a track.",
    arguments: [
      { name: "provider", description: "Provider ID, or default to use your saved selection." },
      { name: "track", description: "Track ID from the search results." },
    ],
    example: "sonory track deezer 3135556",
  },
  {
    name: "formats",
    description: "List the audio formats available for a track.",
    arguments: [
      {
        name: "provider",
        description: "Provider ID, or default. Use sonory providers to check format support.",
      },
      { name: "track", description: "Track ID from the search results." },
    ],
    example: "sonory formats deezer 3135556",
    sections: [
      {
        title: "Deezer",
        lines: [
          "Sign in first with sonory auth deezer. Formats depend on the selected account and track.",
        ],
      },
    ],
  },
  {
    name: "download",
    description: "Save a track to a file.",
    arguments: [
      {
        name: "provider",
        description: "Provider ID, or default. Use sonory providers to check download support.",
      },
      { name: "track", description: "Track ID from the search results." },
      { name: "format", description: "Format ID from the formats command." },
      {
        name: "destination",
        description: "Output file path. An existing file will not be replaced.",
      },
    ],
    example: 'sonory download <provider> <track> <format> "./Music/song.flac"',
    sections: [
      {
        title: "Deezer",
        lines: [
          "Deezer media is delivered encrypted and is decrypted automatically while saving.",
          "Save playable audio directly, such as ./song.mp3 or ./song.flac.",
        ],
      },
    ],
  },
  {
    name: "accounts",
    description: "List saved accounts and show which defaults are selected.",
    arguments: [],
    example: "sonory accounts",
    sections: [
      {
        title: "Manage accounts",
        lines: [
          "remove <provider> <account>    Remove an account and its local credentials",
          "default <provider> <account>   Choose the default account for a provider",
          "provider <provider>            Choose the default music provider",
          "Use sonory accounts <command> --help for details.",
        ],
      },
    ],
  },
  {
    name: "accounts remove",
    description: "Remove a saved account and its local credentials.",
    arguments: [
      { name: "provider", description: "Provider ID shown by sonory accounts." },
      { name: "account", description: "Account ID shown by sonory accounts." },
    ],
    example: "sonory accounts remove deezer <account>",
    sections: [
      {
        title: "Provider session",
        lines: ["Removing a local account does not revoke its session with the provider."],
      },
    ],
  },
  {
    name: "accounts default",
    description: "Choose which account to use for a provider.",
    arguments: [
      { name: "provider", description: "Provider ID shown by sonory accounts." },
      { name: "account", description: "Account ID shown by sonory accounts." },
    ],
    example: "sonory accounts default deezer <account>",
    sections: [
      {
        title: "Account selection",
        lines: [
          "An explicit --account selection takes priority over this default.",
          "A provider with only one saved account uses that account automatically.",
        ],
      },
    ],
  },
  {
    name: "accounts provider",
    description: "Choose which provider to use with the default provider argument.",
    arguments: [{ name: "provider", description: "Provider ID with at least one saved account." }],
    example: "sonory accounts provider deezer",
    sections: [{ title: "Use the default", lines: ['sonory search default "Daft Punk"'] }],
  },
];

export function helpTopic(args: readonly string[]): HelpTopic | undefined {
  return (
    topics.find((topic) => topic.name === args.slice(0, 2).join(" ")) ??
    topics.find((topic) => topic.name === args[0])
  );
}

const syntax = (topic: HelpTopic) =>
  `sonory ${topic.name}${topic.arguments.map((argument) => ` ${argument.optional === true ? `[${argument.name}]` : `<${argument.name}>`}`).join("")}`;
const options = [
  "--account <id>   Use a specific saved account",
  "--json           Print JSON; automatic when output is piped",
  "--help, -h       Show help for this command",
];

export function renderHelp(args: readonly string[] = [], color = false): string {
  const heading = (text: string) =>
    color ? styleText("bold", text, { validateStream: false }) : text;
  const section = (title: string, lines: readonly string[]) =>
    `${heading(title)}\n${lines.map((line) => `  ${line}`).join("\n")}`;
  const topic = helpTopic(args);
  if (topic === undefined) {
    return [
      heading("Sonory"),
      "Extensible provider-neutral music workbench.",
      section("Usage", ["sonory <command> [options]"]),
      section(
        "Commands",
        topics
          .filter((item) => !item.name.includes(" "))
          .map((item) => `${item.name.padEnd(12)}${item.description}`),
      ),
      section("Start here", ["sonory auth", 'sonory search deezer "Daft Punk"', "sonory accounts"]),
      section("Options", options),
      "Run sonory <command> --help for arguments and examples.",
    ].join("\n\n");
  }
  return [
    heading(`sonory ${topic.name}`),
    topic.description,
    section("Usage", [syntax(topic)]),
    ...(topic.arguments.length === 0
      ? []
      : [
          section(
            "Arguments",
            topic.arguments.flatMap((argument) => [argument.name, `  ${argument.description}`]),
          ),
        ]),
    ...(topic.sections ?? []).map((item) => section(item.title, item.lines)),
    section("Example", [topic.example]),
    section(
      "Options",
      topic.name === "search"
        ? ["--cursor <value> Continue from a previous search", ...options]
        : topic.name === "auth" || topic.name.startsWith("accounts") || topic.name === "providers"
          ? options.slice(1)
          : options,
    ),
  ].join("\n\n");
}

export function argumentError(args: readonly string[]): string {
  const topic = helpTopic(args);
  if (topic === undefined) return "Unknown command. Run sonory --help to see available commands.";
  if (args[0] === "accounts" && args.length > 1 && topic.name === "accounts")
    return "Unknown accounts command. Run sonory accounts --help to see available commands.";
  const provided = args.length - topic.name.split(" ").length;
  const missing = topic.arguments[provided];
  if (missing !== undefined && missing.optional !== true) return `Missing ${missing.name}.`;
  if (args.some((value) => value.trim().length === 0)) return "Arguments cannot be empty.";
  if (provided > topic.arguments.length)
    return topic.name === "search"
      ? "Too many arguments. Put quotes around search text containing spaces."
      : `Too many arguments for sonory ${topic.name}.`;
  return `Invalid arguments for sonory ${topic.name}.`;
}

export function argumentHint(args: readonly string[], color = false): string {
  const topic = helpTopic(args);
  if (
    topic === undefined ||
    (args[0] === "accounts" && args.length > 1 && topic.name === "accounts")
  )
    return "";
  const label = color ? styleText("bold", "Usage", { validateStream: false }) : "Usage";
  return `${label}\n  ${syntax(topic)}\n\nExample\n  ${topic.example}\n\nRun sonory ${topic.name} --help for details.`;
}
