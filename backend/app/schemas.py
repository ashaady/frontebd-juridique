from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant"]
    content: str = Field(min_length=1, max_length=30000)


class ChatRequest(BaseModel):
    messages: list[ChatMessage] = Field(min_length=1, max_length=100)
    temperature: float = Field(default=0.3, ge=0.0, le=2.0)
    top_p: float = Field(default=0.95, gt=0.0, le=1.0)
    max_tokens: int = Field(default=8192, ge=1, le=8192)
    thinking: bool = Field(default=False)
    use_rag: bool | None = Field(default=None)
    rag_query_rewrite: bool | None = Field(default=None)
    workspace_only: bool = Field(default=False)
    workspace_file_ids: list[str] | None = Field(default=None, max_length=200)


class ConsultationRecord(BaseModel):
    id: str = Field(min_length=1)
    question: str = Field(default="")
    answer: str = Field(default="")
    status: Literal["done", "error"] = Field(default="done")
    finish_reason: str = Field(default="", alias="finishReason")
    rag_note: str = Field(default="", alias="ragNote")
    source_count: int = Field(default=0, ge=0, alias="sourceCount")
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")

    model_config = {
        "populate_by_name": True,
    }


class WorkspaceFileRecord(BaseModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    size: int = Field(default=0, ge=0)
    added_at: datetime = Field(alias="addedAt")

    model_config = {
        "populate_by_name": True,
    }


class WorkspaceNotesPayload(BaseModel):
    notes: str = Field(default="")


class WorkspaceConsultationListResponse(BaseModel):
    items: list[ConsultationRecord]


class WorkspaceFileListResponse(BaseModel):
    items: list[WorkspaceFileRecord]


class WorkspaceFileListPayload(BaseModel):
    items: list[WorkspaceFileRecord]


class WorkspaceTemplateFieldOption(BaseModel):
    value: str = Field(min_length=1)
    label: str = Field(min_length=1)


class WorkspaceTemplateFieldRecord(BaseModel):
    key: str = Field(min_length=1)
    label: str = Field(min_length=1)
    required: bool = Field(default=False)
    placeholder: str | None = Field(default=None)
    type: Literal["text", "textarea", "date", "number", "select"] = Field(default="text")
    options: list[WorkspaceTemplateFieldOption] | None = Field(default=None)
    hint: str | None = Field(default=None)


class WorkspaceTemplateRecord(BaseModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    category: str = Field(default="Modeles personnalises")
    domain: str = Field(default="Personnalise")
    branch: str = Field(default="Document juridique")
    complexity: Literal["Simple", "Intermediaire", "Avance"] = Field(default="Simple")
    description: str = Field(default="")
    legal_refs: list[str] = Field(default_factory=list, alias="legalRefs")
    required_fields: list[str] = Field(default_factory=list, alias="requiredFields")
    optional_fields: list[str] = Field(default_factory=list, alias="optionalFields")
    sections: list[str] = Field(default_factory=list)
    warning: str = Field(default="")
    fields: list[WorkspaceTemplateFieldRecord] = Field(default_factory=list)
    created_at: datetime = Field(alias="createdAt")
    updated_at: datetime = Field(alias="updatedAt")

    model_config = {
        "populate_by_name": True,
    }


class WorkspaceTemplateListResponse(BaseModel):
    items: list[WorkspaceTemplateRecord]
