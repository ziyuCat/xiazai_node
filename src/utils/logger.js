function safeSerialize(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
      code: value.code || null,
      statusCode: value.statusCode || null,
      details: value.details || null,
    };
  }

  if (typeof value === "bigint") {
    return String(value);
  }

  return value;
}

function emit(level, event, fields = {}) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  };

  const serialized = JSON.stringify(payload, (_, value) => safeSerialize(value));

  if (level === "error") {
    console.error(serialized);
    return;
  }

  if (level === "warn") {
    console.warn(serialized);
    return;
  }

  console.log(serialized);
}

function createLogger(baseFields = {}) {
  return {
    child(extraFields = {}) {
      return createLogger({
        ...baseFields,
        ...extraFields,
      });
    },
    debug(event, fields = {}) {
      emit("debug", event, { ...baseFields, ...fields });
    },
    info(event, fields = {}) {
      emit("info", event, { ...baseFields, ...fields });
    },
    warn(event, fields = {}) {
      emit("warn", event, { ...baseFields, ...fields });
    },
    error(event, fields = {}) {
      emit("error", event, { ...baseFields, ...fields });
    },
  };
}

module.exports = {
  createLogger,
};
