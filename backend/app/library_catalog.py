from __future__ import annotations

import hashlib
import re
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .paths import LEGAL_DATA_DIR

SECTION_TITLES: dict[int, str] = {
    1: "DROIT CONSTITUTIONNEL ET INSTITUTIONNEL",
    2: "DROIT CIVIL, DE LA FAMILLE ET PROCEDURE CIVILE",
    3: "DROIT PENAL ET PROCEDURE PENALE",
    4: "DROIT COMMERCIAL ET DES AFFAIRES - OHADA",
    5: "DROIT COMMERCIAL NATIONAL",
    6: "DROIT ADMINISTRATIF ET ORGANISATION DE L'ETAT",
    7: "ORGANISATION JUDICIAIRE ET PROFESSIONS JUDICIAIRES",
    8: "DROIT FONCIER, URBANISME ET CONSTRUCTION",
    9: "DROIT FISCAL ET DOUANIER",
    10: "DROIT BANCAIRE ET FINANCIER",
    11: "DROIT DU TRAVAIL ET SECURITE SOCIALE",
    12: "DROIT DE L'ENVIRONNEMENT ET DES RESSOURCES NATURELLES",
    13: "DROIT DE L'ENERGIE ET DES HYDROCARBURES",
    14: "DROIT DE LA SANTE",
    15: "DROIT DU NUMERIQUE ET DES COMMUNICATIONS",
    16: "DROIT REGIONAL - CEDEAO / UEMOA / BCEAO",
    17: "JURISPRUDENCE - COUR SUPREME DU SENEGAL",
    18: "TEXTES SPECIAUX ET DIVERS",
    99: "NON CLASSES",
}

BLOCK_ORDER: dict[str, int] = {"A": 1, "B": 2, "C": 3, "D": 4, "E": 5}


def _normalize_for_match(value: str) -> str:
    normalized = unicodedata.normalize("NFKD", value or "")
    no_accents = "".join(ch for ch in normalized if not unicodedata.combining(ch))
    lowered = no_accents.lower().replace("%20", " ").replace("&", " et ")
    lowered = re.sub(r"[^a-z0-9]+", " ", lowered)
    return re.sub(r"\s+", " ", lowered).strip()


def _contains_any(text: str, needles: tuple[str, ...]) -> bool:
    return any(token in text for token in needles)


def _contains_all(text: str, needles: tuple[str, ...]) -> bool:
    return all(token in text for token in needles)


def _title_from_stem(stem: str) -> str:
    cleaned = stem.replace("_", " ").replace("-", " ")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return "Document"
    return cleaned[0].upper() + cleaned[1:]


def _doc_id(relative_path: str) -> str:
    return hashlib.sha1(relative_path.encode("utf-8")).hexdigest()[:20]


def _iso_mtime(path: Path) -> str:
    return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()


def _section_label(section_number: int) -> str:
    title = SECTION_TITLES.get(section_number, SECTION_TITLES[99])
    if section_number == 99:
        return f"{section_number} — {title}"
    return f"{section_number:02d} — {title}"


def _taxonomy_meta(
    *,
    section_number: int,
    block_code: str,
    block_title: str,
    subcategory: str,
    description: str,
    note: str = "",
    item_order: int = 500,
) -> dict[str, Any]:
    block_letter = (block_code or "A").upper()
    full_description = description.strip() or "Document juridique."
    if note.strip():
        full_description = f"{full_description} {note.strip()}"
    return {
        "sectionNumber": section_number,
        "sectionLabel": _section_label(section_number),
        "sectionTitle": SECTION_TITLES.get(section_number, SECTION_TITLES[99]),
        "sectionOrder": section_number,
        "blockCode": block_letter,
        "blockTitle": block_title.strip() or "General",
        "blockLabel": f"{block_letter}. {block_title.strip()}" if block_title.strip() else block_letter,
        "blockOrder": BLOCK_ORDER.get(block_letter, 99),
        "subCategory": subcategory.strip() or "General",
        "docType": block_title.strip() or "Texte juridique",
        "description": full_description,
        "curationNote": note.strip(),
        "itemOrder": item_order,
        "isDuplicate": "doublon" in _normalize_for_match(note),
    }


def _classify_bceao(file_norm: str) -> dict[str, Any]:
    if "2 politique efficacite energetique" in file_norm:
        return _taxonomy_meta(
            section_number=13,
            block_code="A",
            block_title="Textes energie et hydrocarbures",
            subcategory="Energie CEDEAO",
            description="Politique regionale d'efficacite energetique.",
            item_order=60,
        )

    if "2 tec" in file_norm:
        return _taxonomy_meta(
            section_number=9,
            block_code="A",
            block_title="Fiscalite et douanes",
            subcategory="Tarif douanier",
            description="Tarif Exterieur Commun CEDEAO.",
            note="Reference aussi utilisee en section regionale CEDEAO.",
            item_order=40,
        )

    if _contains_any(
        file_norm,
        (
            "recueil des textes legaux et reglementaires regissant l activite bancaire",
            "recueil des textes legaux et reglementaires regissant l activite bancaire et financiere",
        ),
    ):
        return _taxonomy_meta(
            section_number=10,
            block_code="A",
            block_title="Reglementation bancaire nationale",
            subcategory="Banque UMOA",
            description="Recueil de reference sur l'activite bancaire et financiere UMOA.",
            item_order=20,
        )

    if _contains_any(
        file_norm,
        (
            "circulaire n 01 2017 cb c",
            "circulaire n 03 2017 cb c",
            "circulaire n 002 2020 cb c",
            "circulaire n 003 2020 cb c",
            "instruction n 001 01 2024",
            "instruction n 001 03 2025",
        ),
    ):
        return _taxonomy_meta(
            section_number=10,
            block_code="B",
            block_title="Circulaires et instructions BCEAO/CB UMOA",
            subcategory="Reglementation prudentielle",
            description="Circulaire ou instruction BCEAO/CB UMOA.",
            item_order=30,
        )

    if _contains_any(
        file_norm,
        (
            "signed electronic transaction",
            "signed personal data",
            "signed cybercrime",
            "mesures de confiance",
            "iterances les reseaud de comm mobiles",
            "regulation conditions for access to bandwidths terrestrial ntwks",
            "dir postal sector reform and regulation",
            "sup rev universal access fre 2017 compressed",
        ),
    ):
        return _taxonomy_meta(
            section_number=15,
            block_code="B",
            block_title="Textes regionaux CEDEAO sur le numerique",
            subcategory="CEDEAO - Cyber/Telecom",
            description="Texte regional CEDEAO en matiere numerique et communications.",
            item_order=40,
        )

    if _contains_any(file_norm, ("libre circulation", "carnet de voyage")):
        return _taxonomy_meta(
            section_number=16,
            block_code="A",
            block_title="Libre circulation des personnes - CEDEAO",
            subcategory="Libre circulation",
            description="Protocole CEDEAO sur la libre circulation ou le carnet de voyage.",
            item_order=10,
        )

    if "programme communautaire de developpement" in file_norm:
        return _taxonomy_meta(
            section_number=16,
            block_code="B",
            block_title="Developpement communautaire CEDEAO",
            subcategory="Developpement",
            description="Programme communautaire CEDEAO de developpement.",
            note="Doublon partiel possible selon la version du document.",
            item_order=20,
        )

    if _contains_any(file_norm, ("recherche scientifique", "politique matiere recherche")):
        return _taxonomy_meta(
            section_number=16,
            block_code="C",
            block_title="Recherche scientifique et politique sectorielle",
            subcategory="Recherche",
            description="Texte CEDEAO relatif a la recherche scientifique.",
            note="Doublon partiel possible selon la version du document.",
            item_order=30,
        )

    if _contains_any(
        file_norm,
        (
            "alerte precoce",
            "analyse conjointe",
            "evaluation des risques",
            "hsaf",
            "genre",
            "reponse",
            "aar",
            "ecomib",
        ),
    ):
        return _taxonomy_meta(
            section_number=16,
            block_code="D",
            block_title="Securite, alerte precoce et reponse humanitaire",
            subcategory="Alerte precoce",
            description="Document CEDEAO sur l'alerte precoce, la securite humaine ou ECOMIB.",
            note="Doublon partiel possible selon la version du document.",
            item_order=40,
        )

    return _taxonomy_meta(
        section_number=16,
        block_code="E",
        block_title="Institutions CEDEAO",
        subcategory="Institutions",
        description="Texte institutionnel CEDEAO/UEMOA/BCEAO.",
        item_order=50,
    )


def _classify_cour_supreme(file_name: str, file_norm: str) -> dict[str, Any]:
    file_name_lower = file_name.lower()
    if "loi organique" in file_norm:
        return _taxonomy_meta(
            section_number=1,
            block_code="C",
            block_title="Cour Supreme",
            subcategory="Cour Supreme",
            description="Texte organique sur l'organisation et le fonctionnement de la Cour Supreme.",
            item_order=20,
        )

    if _contains_any(file_norm, ("table des matieres", "tables des matieres")):
        if "2021" in file_norm:
            return _taxonomy_meta(
                section_number=17,
                block_code="C",
                block_title="Bulletins d'arrets par chambre - 2021",
                subcategory="Index juridique",
                description="Table des matieres des arrets 2021.",
                item_order=95,
            )
        return _taxonomy_meta(
            section_number=17,
            block_code="B",
            block_title="Bulletins d'arrets par chambre - 2020",
            subcategory="Index juridique",
            description="Table des matieres des arrets 2020.",
            item_order=95,
        )

    if "2021" in file_norm:
        return _taxonomy_meta(
            section_number=17,
            block_code="C",
            block_title="Bulletins d'arrets par chambre - 2021",
            subcategory="Jurisprudence",
            description="Bulletin d'arrets Cour Supreme - serie 2021.",
            item_order=60,
        )

    if "2020" in file_norm:
        return _taxonomy_meta(
            section_number=17,
            block_code="B",
            block_title="Bulletins d'arrets par chambre - 2020",
            subcategory="Jurisprudence",
            description="Bulletin d'arrets Cour Supreme - serie 2020.",
            item_order=50,
        )

    if re.match(r"^ba\d", file_name_lower):
        year_match = re.search(r"(20\d{2})", file_name)
        item_order = int(year_match.group(1)) if year_match else 40
        return _taxonomy_meta(
            section_number=17,
            block_code="A",
            block_title="Bulletins d'arrets 2008 a 2019",
            subcategory="Jurisprudence",
            description="Bulletin d'arrets annuel de la Cour Supreme.",
            item_order=item_order,
        )

    return _taxonomy_meta(
        section_number=17,
        block_code="A",
        block_title="Bulletins d'arrets 2008 a 2019",
        subcategory="Jurisprudence",
        description="Document de jurisprudence de la Cour Supreme.",
        item_order=45,
    )


def _classify_ohada(file_norm: str) -> dict[str, Any]:
    if _contains_any(file_norm, ("traite ohada", "harmonisation afrique droit affaires revise quebeq")):
        note = ""
        if "quebeq" in file_norm:
            note = "Doublon partiel possible avec le traite OHADA revise."
        return _taxonomy_meta(
            section_number=4,
            block_code="A",
            block_title="Traites OHADA",
            subcategory="OHADA - Traite",
            description="Traite OHADA revise.",
            note=note,
            item_order=20,
        )

    if _contains_any(file_norm, ("reglement", "ccja", "cour commune de justice et d arbitrage")):
        note = ""
        if "cour commune de justice et d arbitrage" in file_norm:
            note = "Doublon partiel possible du reglement d'arbitrage CCJA."
        return _taxonomy_meta(
            section_number=4,
            block_code="C",
            block_title="Reglements CCJA",
            subcategory="CCJA",
            description="Reglement CCJA (procedure ou arbitrage).",
            note=note,
            item_order=40,
        )

    note = ""
    if "auscgie jo fevrier 2014" in file_norm:
        note = "Doublon partiel possible avec la version courante AUSCGIE."
    if "procedures simplifiees de recouvrement" in file_norm:
        note = "Doublon partiel possible avec l'acte uniforme recouvrement."
    return _taxonomy_meta(
        section_number=4,
        block_code="B",
        block_title="Actes uniformes",
        subcategory="Actes uniformes OHADA",
        description="Acte uniforme OHADA.",
        note=note,
        item_order=30,
    )


def _classify_document(relative_path: str, folder: str, file_name: str, title: str) -> dict[str, Any]:
    _ = title
    path_norm = _normalize_for_match(relative_path)
    file_norm = _normalize_for_match(file_name)
    folder_norm = _normalize_for_match(folder)

    if folder_norm == "cour supreme":
        return _classify_cour_supreme(file_name, file_norm)
    if folder_norm == "pdfs ohada":
        return _classify_ohada(file_norm)
    if folder_norm == "bceao":
        return _classify_bceao(file_norm)

    if folder_norm == "constitution":
        order = 30
        if "historique" in file_norm:
            order = 20
        if "mises a jour" in file_norm:
            order = 40
        if _contains_all(file_norm, ("constitution", "senegal")) and "historique" not in file_norm:
            order = 10
        return _taxonomy_meta(
            section_number=1,
            block_code="A",
            block_title="Textes constitutionnels",
            subcategory="Constitution",
            description="Texte constitutionnel du Senegal.",
            item_order=order,
        )

    if folder_norm == "conseil constitutionnel":
        return _taxonomy_meta(
            section_number=1,
            block_code="B",
            block_title="Conseil constitutionnel",
            subcategory="Conseil constitutionnel",
            description="Organisation et fonctionnement du Conseil constitutionnel.",
            item_order=10,
        )

    if folder_norm == "cours des comptes":
        return _taxonomy_meta(
            section_number=1,
            block_code="D",
            block_title="Cour des Comptes",
            subcategory="Cour des Comptes",
            description="Textes organiques et decret d'application de la Cour des Comptes.",
            item_order=20 if "decret" in file_norm else 10,
        )

    if folder_norm == "assemblee nationale":
        return _taxonomy_meta(
            section_number=1,
            block_code="E",
            block_title="Assemblee nationale",
            subcategory="Parlement",
            description="Reglement interieur de l'Assemblee nationale.",
            item_order=10,
        )

    if folder_norm in (
        "code des obligations civiles et commerciales",
        "droit de la famille",
        "nationalite",
        "loi n 66 69 du 4 juillet 1966",
    ):
        subcategory = "Droit civil"
        if "famille" in folder_norm or "famille" in file_norm:
            subcategory = "Famille"
        if "nationalite" in folder_norm or "nationalite" in file_norm:
            subcategory = "Nationalite"
        if "66 69" in file_norm or "statut personnel" in file_norm:
            subcategory = "Statut personnel"
        return _taxonomy_meta(
            section_number=2,
            block_code="A",
            block_title="Droit civil substantiel",
            subcategory=subcategory,
            description="Texte de droit civil et de la famille.",
            item_order=10,
        )

    if folder_norm == "code de procedure civile":
        item_order = 50
        if file_norm == "cpc pdf" or file_norm.startswith("cpc "):
            item_order = 10
        if "64 572" in file_norm:
            item_order = 20
        if "75 813" in file_norm:
            item_order = 30
        if "75 835" in file_norm:
            item_order = 31
        if "75 1090" in file_norm:
            item_order = 32
        if "76 1031" in file_norm:
            item_order = 33
        if "78 356" in file_norm:
            item_order = 34
        if "82 209" in file_norm:
            item_order = 35
        if "86 060" in file_norm:
            item_order = 36
        if "88 1753" in file_norm:
            item_order = 37
        if "92 1743" in file_norm:
            item_order = 38
        if "92 1745" in file_norm:
            item_order = 39
        if "2001 1151" in file_norm:
            item_order = 40
        if "2013 1071" in file_norm:
            item_order = 41
        note = ""
        if _contains_all(file_norm, ("65 758", "512", "513", "cpp")):
            note = "Classe dans CPC mais ce texte vise des articles du CPP."
        return _taxonomy_meta(
            section_number=2,
            block_code="B",
            block_title="Procedure civile - Code principal et decrets",
            subcategory="CPC",
            description="Code de procedure civile ou decret modificatif.",
            note=note,
            item_order=item_order,
        )

    if folder_norm in ("droit penal", "code de procedure penal", "code des drogues", "loi sur la cybercriminalite"):
        if folder_norm == "code de procedure penal" or "code procedure penal" in file_norm:
            return _taxonomy_meta(
                section_number=3,
                block_code="A",
                block_title="Textes fondamentaux",
                subcategory="CPP",
                description="Code de procedure penale.",
                item_order=20,
            )
        if "droit penal" in folder_norm and "droit penal" in file_norm:
            return _taxonomy_meta(
                section_number=3,
                block_code="A",
                block_title="Textes fondamentaux",
                subcategory="Code penal",
                description="Code penal consolide.",
                item_order=10,
            )
        note = ""
        if "criminalisation des actes de viol et de pedophilie" in file_norm:
            note = "Doublon du texte de loi n°2020-05."
        if folder_norm == "loi sur la cybercriminalite":
            note = "Egalement reference dans la section numerique."
        return _taxonomy_meta(
            section_number=3,
            block_code="B",
            block_title="Lois modificatives et speciales",
            subcategory="Infractions speciales",
            description="Loi ou decret special en matiere penale.",
            note=note,
            item_order=30,
        )

    if folder_norm in (
        "code des investissements",
        "loi orientation n 2020 02 du 07 janvier 2020 relative aux pme",
        "code des marches publics",
        "loi sur les prix et la protection du consommateur",
        "loi n 2019 04 du 1er fevrier 2019 relative au contenu local dans le secteur des hydrocarbures",
        "code maritime",
        "code de l aviation civile",
        "loi n 2021 23 du 02 mars 2021 relative aux contrats de partenariat public prive 2",
        "code electoral",
        "code de la route",
    ):
        subcategory = "Commercial national"
        if "investissements" in file_norm or "investissements" in folder_norm:
            subcategory = "Investissements"
        elif "pme" in file_norm:
            subcategory = "PME"
        elif "marches publics" in file_norm:
            subcategory = "Marches publics"
        elif "protection du consommateur" in file_norm:
            subcategory = "Consommation"
        elif "partenariat public prive" in file_norm:
            subcategory = "PPP"
        elif "maritime" in file_norm:
            subcategory = "Maritime"
        elif "aviation" in file_norm:
            subcategory = "Aviation civile"
        elif "contenu local" in file_norm:
            subcategory = "Contenu local"
        elif "electoral" in file_norm:
            subcategory = "Elections"
        elif "route" in file_norm:
            subcategory = "Route"
        return _taxonomy_meta(
            section_number=5,
            block_code="A",
            block_title="Textes commerciaux nationaux",
            subcategory=subcategory,
            description="Texte commercial national.",
            item_order=50,
        )

    if folder_norm in (
        "organisation de l administration",
        "code general des collectivites locales",
        "ofnac",
        "declaration de patrimoine",
        "loi n 2025 15 relative a l acces a l informati 250924 161820",
    ):
        if folder_norm == "code general des collectivites locales":
            return _taxonomy_meta(
                section_number=6,
                block_code="B",
                block_title="Collectivites locales",
                subcategory="Collectivites locales",
                description="Code general des collectivites locales.",
                item_order=20,
            )
        if folder_norm in ("ofnac", "declaration de patrimoine") or "acces a l informati" in folder_norm:
            return _taxonomy_meta(
                section_number=6,
                block_code="C",
                block_title="Transparence, anti-corruption et acces a l'information",
                subcategory="Transparence",
                description="Texte de transparence, anti-corruption ou acces a l'information.",
                item_order=30,
            )
        return _taxonomy_meta(
            section_number=6,
            block_code="A",
            block_title="Textes fondamentaux",
            subcategory="Administration",
            description="Texte d'organisation administrative de l'Etat.",
            item_order=10,
        )

    if folder_norm in (
        "organisation judiciaire",
        "professions judiciaires et extra judiciaires",
        "notariat",
    ):
        if folder_norm == "organisation judiciaire":
            return _taxonomy_meta(
                section_number=7,
                block_code="A",
                block_title="Organisation judiciaire",
                subcategory="Organisation judiciaire",
                description="Texte d'organisation des juridictions et services judiciaires.",
                item_order=10,
            )
        if _contains_any(file_norm, ("magistrat", "conseil superieur de la magistrature", "loi 2017 10", "loi 2017 11")):
            note = "Doublon possible sur les fichiers Loi-2017-10."
            return _taxonomy_meta(
                section_number=7,
                block_code="B",
                block_title="Magistrature",
                subcategory="Magistrature",
                description="Texte relatif au statut des magistrats ou au CSM.",
                note=note if "loi 2017 10" in file_norm else "",
                item_order=20,
            )
        note = ""
        if "decret n 2020 1524 du 17 juillet 2020" in file_norm or "decret 2020 1524 fixant le statut des notaires" in file_norm:
            note = "Doublon entre les dossiers Notariat et Professions judiciaires."
        if file_norm in ("arrete 3 pdf", "loi 98 23 pdf"):
            note = "Contenu a verifier manuellement."
        return _taxonomy_meta(
            section_number=7,
            block_code="C",
            block_title="Professions judiciaires",
            subcategory="Professions judiciaires",
            description="Texte sur les professions judiciaires ou parajudiciaires.",
            note=note,
            item_order=30,
        )

    if folder_norm in (
        "regime foncier senegal terrain2011",
        "code de l urbanisme",
        "code de la construction",
        "code de l assainissement",
        "code de l eau",
        "code de l hygiene",
    ):
        subcategory = "Foncier/Urbanisme"
        if "construction" in file_norm:
            subcategory = "Construction"
        elif "assainissement" in file_norm:
            subcategory = "Assainissement"
        elif "eau" in file_norm:
            subcategory = "Eau"
        elif "hygiene" in file_norm:
            subcategory = "Hygiene"
        elif "urbanisme" in file_norm:
            subcategory = "Urbanisme"
        elif "foncier" in file_norm:
            subcategory = "Foncier"
        return _taxonomy_meta(
            section_number=8,
            block_code="A",
            block_title="Foncier, urbanisme et construction",
            subcategory=subcategory,
            description="Texte foncier, urbanisme, construction ou assainissement.",
            item_order=10,
        )

    if folder_norm in ("code general des impots", "code des douanes", "uemoa", "loi de finances"):
        subcategory = "Fiscalite/Douanes"
        if "impot" in file_norm:
            subcategory = "Fiscalite"
        elif "douane" in file_norm:
            subcategory = "Douanes"
        elif "loi de finances" in file_norm or folder_norm == "loi de finances":
            subcategory = "Budget"
        elif "pratiques commerciales anticoncurrentielles" in file_norm:
            subcategory = "UEMOA - Concurrence"
        elif "reglement n 3 2002" in file_norm:
            subcategory = "UEMOA - Paiement"
        return _taxonomy_meta(
            section_number=9,
            block_code="A",
            block_title="Fiscalite et douanes",
            subcategory=subcategory,
            description="Texte fiscal, douanier ou reglement UEMOA connexe.",
            item_order=20,
        )

    if folder_norm in (
        "reglementation bancaire",
        "loi n 2024 08 du 14 fevrier 2024 relative a la lutte contre le blanchiment de capitaux le financement du terrorisme et de la proliferation des armes de destruction massive lbc ft padm",
    ):
        if "lbc" in file_norm or "blanchiment" in file_norm:
            return _taxonomy_meta(
                section_number=10,
                block_code="C",
                block_title="Lutte contre le blanchiment (LBC/FT)",
                subcategory="LBC/FT",
                description="Loi sur la lutte contre le blanchiment et le financement du terrorisme.",
                item_order=40,
            )
        return _taxonomy_meta(
            section_number=10,
            block_code="A",
            block_title="Reglementation bancaire nationale",
            subcategory="Banque",
            description="Texte national de reglementation bancaire.",
            item_order=10,
        )

    if folder_norm in ("droit du travail", "code securite social"):
        subcategory = "Code du travail"
        if "securite social" in folder_norm or "securite social" in file_norm:
            subcategory = "Securite sociale"
        return _taxonomy_meta(
            section_number=11,
            block_code="A",
            block_title="Droit du travail et securite sociale",
            subcategory=subcategory,
            description="Texte de droit du travail ou de securite sociale.",
            item_order=10,
        )

    if folder_norm in ("code de l environnement", "code forestier", "code minier"):
        subcategory = "Environnement"
        if "forestier" in file_norm:
            subcategory = "Forets"
        elif "minier" in file_norm:
            subcategory = "Mines"
        return _taxonomy_meta(
            section_number=12,
            block_code="A",
            block_title="Environnement et ressources naturelles",
            subcategory=subcategory,
            description="Texte environnemental ou ressources naturelles.",
            item_order=10,
        )

    if folder_norm in (
        "loi n 2021 31 du 9 juillet 2021 portant code de lelectricite",
        "code gazier",
        "code petrolier",
    ):
        subcategory = "Energie"
        if "electricite" in file_norm:
            subcategory = "Electricite"
        elif "gazier" in file_norm:
            subcategory = "Gaz"
        elif "petrolier" in file_norm:
            subcategory = "Petrole"
        return _taxonomy_meta(
            section_number=13,
            block_code="A",
            block_title="Energie et hydrocarbures",
            subcategory=subcategory,
            description="Texte du secteur energie, gazier ou petrolier.",
            item_order=20,
        )

    if folder_norm in (
        "code de deontologie vers mars2019",
        "loi n 2009 17 sur la recherche en sante",
        "loi n 2010 03 du 9 avril 2010 relative au vih sida",
        "loi n 2015 22 du 08 decembre 2015 relative au don prelevement et a la transplantation dorganes e",
    ):
        subcategory = "Sante publique"
        if "deontologie" in file_norm:
            subcategory = "Deontologie medicale"
        elif "transplantation" in file_norm or "organes" in file_norm:
            subcategory = "Organes"
        return _taxonomy_meta(
            section_number=14,
            block_code="A",
            block_title="Droit de la sante",
            subcategory=subcategory,
            description="Texte juridique du secteur de la sante.",
            item_order=10,
        )

    if folder_norm in (
        "code des communications electroniques",
        "loi sur la protection des donnees a caracter personnelle",
        "code de la presse",
    ):
        subcategory = "Numerique"
        if "communications electroniques" in file_norm:
            subcategory = "Telecom"
        elif "protection des donnees" in file_norm:
            subcategory = "Donnees personnelles"
        elif "presse" in file_norm:
            subcategory = "Presse"
        return _taxonomy_meta(
            section_number=15,
            block_code="A",
            block_title="Droit national du numerique",
            subcategory=subcategory,
            description="Texte national du numerique et des communications.",
            item_order=20,
        )

    if folder_norm == "tourisme":
        return _taxonomy_meta(
            section_number=18,
            block_code="A",
            block_title="Tourisme",
            subcategory="Tourisme",
            description="Texte special relatif au tourisme.",
            item_order=10,
        )

    if "loi sur la cybercriminalite" in path_norm:
        return _taxonomy_meta(
            section_number=3,
            block_code="B",
            block_title="Lois modificatives et speciales",
            subcategory="Cybercriminalite",
            description="Loi relative a la cybercriminalite.",
            note="Egalement reference dans la section numerique.",
            item_order=45,
        )

    return _taxonomy_meta(
        section_number=99,
        block_code="A",
        block_title="Documents non classes",
        subcategory="Non classe",
        description="Document present mais non mappe dans la taxonomie cible.",
        item_order=9999,
    )


def list_legal_pdf_documents() -> list[dict[str, Any]]:
    if not LEGAL_DATA_DIR.exists():
        return []

    rows: list[dict[str, Any]] = []
    for file_path in LEGAL_DATA_DIR.rglob("*.pdf"):
        if not file_path.is_file():
            continue
        try:
            relative = file_path.relative_to(LEGAL_DATA_DIR).as_posix()
        except ValueError:
            continue
        folder = file_path.parent.name
        title = _title_from_stem(file_path.stem)
        taxonomy = _classify_document(relative, folder, file_path.name, title)
        rows.append(
            {
                "id": _doc_id(relative),
                "title": title,
                "description": str(taxonomy["description"]),
                "category": str(taxonomy["sectionLabel"]),
                "docType": str(taxonomy["docType"]),
                "sectionNumber": int(taxonomy["sectionNumber"]),
                "sectionLabel": str(taxonomy["sectionLabel"]),
                "sectionTitle": str(taxonomy["sectionTitle"]),
                "blockCode": str(taxonomy["blockCode"]),
                "blockTitle": str(taxonomy["blockTitle"]),
                "blockLabel": str(taxonomy["blockLabel"]),
                "subCategory": str(taxonomy["subCategory"]),
                "curationNote": str(taxonomy["curationNote"]),
                "isDuplicate": bool(taxonomy["isDuplicate"]),
                "folder": folder,
                "fileName": file_path.name,
                "relativePath": relative,
                "size": file_path.stat().st_size,
                "updatedAt": _iso_mtime(file_path),
                "_sectionOrder": int(taxonomy["sectionOrder"]),
                "_blockOrder": int(taxonomy["blockOrder"]),
                "_itemOrder": int(taxonomy["itemOrder"]),
            }
        )

    rows.sort(
        key=lambda row: (
            int(row.get("_sectionOrder", 9999)),
            int(row.get("_blockOrder", 99)),
            int(row.get("_itemOrder", 9999)),
            _normalize_for_match(str(row.get("subCategory", ""))),
            _normalize_for_match(str(row.get("title", ""))),
        )
    )
    for row in rows:
        row.pop("_sectionOrder", None)
        row.pop("_blockOrder", None)
        row.pop("_itemOrder", None)
    return rows


def resolve_document_path(relative_path: str) -> Path:
    base = LEGAL_DATA_DIR.resolve()
    candidate = (LEGAL_DATA_DIR / relative_path).resolve()
    if base not in candidate.parents and candidate != base:
        raise ValueError("Invalid path.")
    if not candidate.exists() or not candidate.is_file():
        raise FileNotFoundError(relative_path)
    return candidate
