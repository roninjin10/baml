//! Direct-import projection used by editor and bundler tooling.
//!
//! This lives beside the SDK emitter so every TypeScript surface consumes the
//! same `SymbolPool` and, critically, the same structural `Ty` translator.
//! The tooling host supplies the compiler export document only for stable
//! symbol ids and source-map decoration; it is never used to reconstruct a
//! type from display text.

use std::{collections::BTreeSet, fmt::Write as _};

use baml_codegen_types::{Symbol, SymbolPool, Ty};
use baml_surface::{PackageExport, export::ItemDetail};

use crate::{
    routing::route,
    translate_ty::{TranslateCtx, translate_ty},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolingDeclarationRole {
    Declaration,
    Type,
    Documentation,
    Synthetic,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolingMappedSpan {
    pub start_utf16: u32,
    pub length_utf16: u32,
    pub symbol_id: String,
    pub role: ToolingDeclarationRole,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolingEmitOutput {
    pub declaration: String,
    pub code: String,
    pub spans: Vec<ToolingMappedSpan>,
    pub type_exports: BTreeSet<String>,
    pub value_exports: BTreeSet<String>,
}

struct Writer {
    text: String,
    spans: Vec<ToolingMappedSpan>,
}

impl Writer {
    fn push(&mut self, text: &str) {
        self.text.push_str(text);
    }

    fn mapped(&mut self, text: &str, symbol_id: &str, role: ToolingDeclarationRole) {
        let start_utf16 = u32::try_from(self.text.encode_utf16().count())
            .expect("generated TypeScript declaration exceeds u32 UTF-16 offsets");
        self.text.push_str(text);
        self.spans.push(ToolingMappedSpan {
            start_utf16,
            length_utf16: u32::try_from(text.encode_utf16().count())
                .expect("generated TypeScript segment exceeds u32 UTF-16 offsets"),
            symbol_id: symbol_id.to_string(),
            role,
        });
    }

    fn mapped_type(&mut self, ty: &Ty, current: &baml_codegen_types::Name, head: Option<&str>) {
        let translated = translate_ty(
            ty,
            &TranslateCtx {
                current_leaf: route(current),
            },
        );
        if let Some(symbol_id) = head {
            self.mapped(&translated.expr, symbol_id, ToolingDeclarationRole::Type);
        } else {
            self.push(&translated.expr);
        }
    }
}

/// Emit the declaration and JavaScript projections for a direct `.baml`
/// import. Type expressions are translated from compiler-owned `Ty` values.
pub fn emit_tooling_module(
    pool: &SymbolPool,
    exports: &PackageExport,
    runtime_id: &str,
    runtime_package: &str,
    banner: &str,
) -> ToolingEmitOutput {
    let mut out = Writer {
        text: banner.to_string(),
        spans: Vec::new(),
    };
    let mut type_exports = BTreeSet::new();
    let mut value_exports = BTreeSet::new();

    for item in &exports.items {
        let symbol = pool
            .iter()
            .find(|(name, _)| name.name().as_str() == item.name);
        if let Some(doc) = &item.docstring {
            let doc = format!("/** {} */", escape_doc(doc));
            out.mapped(&doc, &item.id, ToolingDeclarationRole::Documentation);
            out.push("\n");
        }
        match (&item.detail, symbol) {
            (ItemDetail::Class { fields, .. }, Some((name, Symbol::Class(class)))) => {
                type_exports.insert(item.name.clone());
                out.push("export interface ");
                out.mapped(&item.name, &item.id, declaration_role(item.synthetic));
                out.push(" {\n");
                for field in fields {
                    let Some(property) = class
                        .properties
                        .iter()
                        .find(|p| p.name.as_str() == field.name)
                    else {
                        continue;
                    };
                    if let Some(doc) = &field.docstring {
                        let _ = writeln!(out.text, "  /** {} */", escape_doc(doc));
                    }
                    out.push("  ");
                    out.mapped(&field.name, &field.id, ToolingDeclarationRole::Declaration);
                    out.push(": ");
                    out.mapped_type(&property.ty, name, field.ty.head.as_deref());
                    out.push(";\n");
                }
                out.push("}\n\n");
            }
            (ItemDetail::Interface { .. }, _) => {
                type_exports.insert(item.name.clone());
                out.push("export interface ");
                out.mapped(&item.name, &item.id, declaration_role(item.synthetic));
                out.push(" {}\n\n");
            }
            (ItemDetail::Enum { variants, .. }, Some((_, Symbol::Enum(enm)))) => {
                type_exports.insert(item.name.clone());
                value_exports.insert(item.name.clone());
                out.push("export enum ");
                out.mapped(&item.name, &item.id, declaration_role(item.synthetic));
                out.push(" {\n");
                for variant in variants {
                    out.push("  ");
                    out.mapped(
                        &variant.name,
                        &variant.id,
                        ToolingDeclarationRole::Declaration,
                    );
                    let value = enm
                        .variants
                        .iter()
                        .find(|v| v.name.as_str() == variant.name)
                        .map_or(variant.name.as_str(), |v| v.value.as_str());
                    let _ = writeln!(out.text, " = {value:?},");
                }
                out.push("}\n\n");
            }
            (ItemDetail::TypeAlias { resolved }, Some((name, Symbol::TypeAlias(alias)))) => {
                type_exports.insert(item.name.clone());
                out.push("export type ");
                out.mapped(&item.name, &item.id, declaration_role(item.synthetic));
                out.push(" = ");
                out.mapped_type(&alias.resolves_to, name, resolved.head.as_deref());
                out.push(";\n\n");
            }
            (ItemDetail::Function { .. } | ItemDetail::Plain {}, _) => {}
            // A compiler export and codegen pool should agree. Keeping the
            // unmatched arm non-panicking lets diagnostics remain available
            // during compiler evolution, but emits no guessed declaration.
            _ => {}
        }
    }

    type_exports.insert("BamlClient".to_string());
    value_exports.insert("b".to_string());
    out.push("export interface BamlClient {\n");
    for item in &exports.items {
        let ItemDetail::Function { signature } = &item.detail else {
            continue;
        };
        let Some((name, Symbol::Function(function))) = pool
            .iter()
            .find(|(name, _)| name.name().as_str() == item.name)
        else {
            continue;
        };
        out.push("  readonly ");
        out.mapped(&item.name, &item.id, declaration_role(item.synthetic));
        out.push(": (");
        for (index, (param, argument)) in
            signature.params.iter().zip(&function.arguments).enumerate()
        {
            if index > 0 {
                out.push(", ");
            }
            out.push(&param.name);
            if param.optional {
                out.push("?");
            }
            out.push(": ");
            out.mapped_type(&argument.ty, name, param.ty.head.as_deref());
        }
        out.push(") => Promise<");
        out.mapped_type(
            &function.return_type,
            name,
            signature.returns.head.as_deref(),
        );
        out.push(">;\n");
    }
    out.push("}\nexport declare const b: BamlClient;\n");

    let uses_runtime_types = out.text.contains("baml.media.")
        || out.text.contains("baml.llm.")
        || out.text.contains("_BamlHandle");
    if uses_runtime_types {
        // Materialize the canonical translator's stdlib namespace references
        // as aliases to the actual runtime-owned values. Direct imports and
        // generated SDKs therefore expose the same media/stream identities.
        let preamble = format!(
            "import type {{ BamlAudio as __BamlAudio, BamlHandle as _BamlHandle, BamlImage as __BamlImage, BamlPdf as __BamlPdf, BamlStream as __BamlStream, BamlVideo as __BamlVideo }} from {runtime_package:?};\n\
             declare namespace baml {{ namespace media {{ type Image = __BamlImage; type Audio = __BamlAudio; type Video = __BamlVideo; type Pdf = __BamlPdf; }} namespace llm {{ type Stream<TStream, TFinal = TStream> = __BamlStream<TStream, TFinal>; }} }}\n\n"
        );
        let delta = u32::try_from(preamble.encode_utf16().count())
            .expect("generated TypeScript preamble exceeds u32 UTF-16 offsets");
        out.text.insert_str(banner.len(), &preamble);
        for span in &mut out.spans {
            span.start_utf16 = span
                .start_utf16
                .checked_add(delta)
                .expect("generated TypeScript declaration exceeds u32 UTF-16 offsets");
        }
    }

    let mut code = format!("import {{ defineFunction }} from {runtime_id:?};\n");
    for item in &exports.items {
        let ItemDetail::Enum { variants, .. } = &item.detail else {
            continue;
        };
        let _ = writeln!(code, "export const {} = {{", item.name);
        for variant in variants {
            let _ = writeln!(code, "  {}: {:?},", variant.name, variant.name);
        }
        code.push_str("};\n");
    }
    code.push_str("export const b = {\n");
    for item in &exports.items {
        let ItemDetail::Function { signature } = &item.detail else {
            continue;
        };
        let params = signature
            .params
            .iter()
            .map(|param| format!("{:?}", param.name))
            .collect::<Vec<_>>()
            .join(", ");
        let fqn = item
            .id
            .split_once(':')
            .map_or(item.id.as_str(), |(_, fqn)| fqn);
        let _ = writeln!(
            code,
            "  {0}: defineFunction({1:?}, \"async\", [{params}]),",
            item.name, fqn
        );
    }
    code.push_str("};\n");

    ToolingEmitOutput {
        declaration: out.text,
        code,
        spans: out.spans,
        type_exports,
        value_exports,
    }
}

fn declaration_role(synthetic: bool) -> ToolingDeclarationRole {
    if synthetic {
        ToolingDeclarationRole::Synthetic
    } else {
        ToolingDeclarationRole::Declaration
    }
}

fn escape_doc(doc: &str) -> String {
    doc.replace("*/", "*\\/").replace(['\r', '\n'], " ")
}
