export default function setup(): () => void {
  const previousTimezone = process.env["TZ"];
  process.env["TZ"] = "UTC";

  return () => {
    if (previousTimezone === undefined) {
      delete process.env["TZ"];
    } else {
      process.env["TZ"] = previousTimezone;
    }
  };
}
