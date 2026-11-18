//! `{{ variable }}` substitution. Deliberately single-pass (values are not
//! re-scanned), which prevents recursive expansion and template injection loops.

use crate::models::Variables;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Resolved {
    pub value: String,
    pub missing: Vec<String>,
}

pub fn resolve(input: &str, variables: &Variables) -> Resolved {
    let mut output = String::with_capacity(input.len());
    let mut missing = BTreeSet::new();
    let mut cursor = 0usize;

    while let Some(relative_start) = input[cursor..].find("{{") {
        let start = cursor + relative_start;
        output.push_str(&input[cursor..start]);
        let value_start = start + 2;

        let Some(relative_end) = input[value_start..].find("}}") else {
            // Unterminated placeholder: keep the rest verbatim.
            output.push_str(&input[start..]);
            cursor = input.len();
            break;
        };

        let value_end = value_start + relative_end;
        let key = input[value_start..value_end].trim();

        if key.is_empty() {
            output.push_str(&input[start..value_end + 2]);
        } else if let Some(value) = variables.get(key) {
            output.push_str(value);
        } else if let Some(value) = super::dynamic::dynamic_value(key) {
            // {{$uuid}}-style built-ins: evaluated fresh on every occurrence.
            output.push_str(&value);
        } else if super::dynamic::is_dynamic(key) {
            // Unknown $token: keep verbatim, but never report as missing.
            output.push_str(&input[start..value_end + 2]);
        } else {
            missing.insert(key.to_string());
            // Keep the placeholder so the user can see exactly what is missing.
            output.push_str(&input[start..value_end + 2]);
        }

        cursor = value_end + 2;
    }

    if cursor < input.len() {
        output.push_str(&input[cursor..]);
    }

    Resolved {
        value: output,
        missing: missing.into_iter().collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(items: &[(&str, &str)]) -> Variables {
        items
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect()
    }

    #[test]
    fn substitutes_single_and_multiple_variables() {
        let variables = vars(&[("baseUrl", "https://api.example.com"), ("version", "v2")]);
        let result = resolve("{{baseUrl}}/{{ version }}/users", &variables);
        assert_eq!(result.value, "https://api.example.com/v2/users");
        assert!(result.missing.is_empty());
    }

    #[test]
    fn reports_missing_variables_and_keeps_placeholder() {
        let result = resolve("{{baseUrl}}/users?token={{token}}", &vars(&[]));
        assert_eq!(result.value, "{{baseUrl}}/users?token={{token}}");
        assert_eq!(result.missing, vec!["baseUrl", "token"]);
    }

    #[test]
    fn duplicate_missing_variables_are_reported_once() {
        let result = resolve("{{a}}/{{a}}/{{a}}", &vars(&[]));
        assert_eq!(result.missing, vec!["a"]);
    }

    #[test]
    fn does_not_recursively_expand_values() {
        let result = resolve("{{a}}", &vars(&[("a", "{{b}}"), ("b", "secret")]));
        assert_eq!(result.value, "{{b}}");
    }

    #[test]
    fn handles_unterminated_and_empty_placeholders() {
        assert_eq!(resolve("/x/{{oops", &vars(&[])).value, "/x/{{oops");
        assert_eq!(resolve("/x/{{   }}/y", &vars(&[])).value, "/x/{{   }}/y");
        assert_eq!(resolve("plain text", &vars(&[])).value, "plain text");
    }

    #[test]
    fn dynamic_variables_resolve_without_missing_warnings() {
        let result = resolve(
            "{{baseUrl}}/log?ts={{$timestamp}}&id={{$uuid}}&mail={{$email}}",
            &vars(&[("baseUrl", "https://api.example.com")]),
        );
        assert!(result.value.starts_with("https://api.example.com/log?ts="));
        assert!(result.missing.is_empty(), "missing: {:?}", result.missing);
        // UUID-shaped and each occurrence of the same token is independent.
        let id = result.value.split("id=").nth(1).unwrap().split('&').next().unwrap();
        assert_eq!(id.len(), 36);

        // User-defined variables take precedence over dynamic built-ins.
        let result = resolve("{{$timestamp}}", &vars(&[("$timestamp", "1700000000")]));
        assert_eq!(result.value, "1700000000");

        // Unknown $tokens are kept verbatim and not reported as missing.
        let result = resolve("{{$nope}}", &vars(&[]));
        assert_eq!(result.value, "{{$nope}}");
        assert!(result.missing.is_empty());

        // Normal missing variables still warn.
        let result = resolve("{{token}}", &vars(&[]));
        assert_eq!(result.missing, vec!["token"]);
    }
}
