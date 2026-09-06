from __future__ import annotations

import asyncio
import logging
from io import BytesIO
from typing import Any

import aiohttp

logger = logging.getLogger(__name__)


class MaxApiError(RuntimeError):
    pass


class MaxClient:
    def __init__(self, token: str, api_base: str) -> None:
        self.api_base = api_base.rstrip("/")
        self.headers = {"Authorization": token}
        self.session: aiohttp.ClientSession | None = None

    async def start(self) -> None:
        timeout = aiohttp.ClientTimeout(total=120, connect=20)
        self.session = aiohttp.ClientSession(headers=self.headers, timeout=timeout)

    async def close(self) -> None:
        if self.session:
            await self.session.close()
            self.session = None

    def _session(self) -> aiohttp.ClientSession:
        if self.session is None:
            raise RuntimeError("MAX API client is not started")
        return self.session

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        url = f"{self.api_base}{path}"
        last_error: Exception | None = None
        for attempt in range(4):
            try:
                async with self._session().request(
                    method, url, params=params, json=json
                ) as response:
                    body = await response.text()
                    if response.status == 429 or response.status >= 500:
                        raise MaxApiError(f"MAX API {response.status}: {body[:500]}")
                    if response.status >= 400:
                        raise MaxApiError(f"MAX API {response.status}: {body[:1000]}")
                    if not body:
                        return {}
                    result = await response.json(content_type=None)
                    if isinstance(result, dict) and result.get("success") is False:
                        raise MaxApiError(f"MAX API error: {result}")
                    return result
            except (aiohttp.ClientError, TimeoutError, MaxApiError) as exc:
                last_error = exc
                if attempt == 3:
                    break
                await asyncio.sleep(2**attempt)
        raise MaxApiError(str(last_error))

    async def get_me(self) -> dict[str, Any]:
        return await self.request("GET", "/me")

    async def send_message(
        self,
        user_id: int,
        text: str,
        buttons: list[list[dict[str, Any]]] | None = None,
        attachments: list[dict[str, Any]] | None = None,
        *,
        notify: bool = True,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"text": text, "notify": notify}
        all_attachments = list(attachments or [])
        if buttons:
            all_attachments.append({"type": "inline_keyboard", "payload": {"buttons": buttons}})
        if all_attachments:
            payload["attachments"] = all_attachments
        return await self.request("POST", "/messages", params={"user_id": user_id}, json=payload)

    async def answer_callback(
        self,
        callback_id: str,
        notification: str,
    ) -> dict[str, Any]:
        return await self.request(
            "POST",
            "/answers",
            params={"callback_id": callback_id},
            json={"notification": notification[:200]},
        )

    async def get_updates(self, marker: int | None, poll_timeout: int = 30) -> dict[str, Any]:
        params: dict[str, Any] = {
            "timeout": poll_timeout,
            "limit": 100,
            "types": "message_created,message_callback,bot_started,bot_stopped",
        }
        if marker is not None:
            params["marker"] = marker
        return await self.request("GET", "/updates", params=params)

    async def upload_file(self, filename: str, content: bytes) -> str:
        upload = await self.request("POST", "/uploads", params={"type": "file"})
        upload_url = upload.get("url")
        if not upload_url:
            raise MaxApiError(f"MAX API did not return upload URL: {upload}")

        form = aiohttp.FormData()
        form.add_field(
            "data",
            BytesIO(content),
            filename=filename,
            content_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        )
        async with self._session().post(upload_url, data=form) as response:
            body = await response.text()
            if response.status >= 400:
                raise MaxApiError(f"MAX upload {response.status}: {body[:1000]}")
            result = await response.json(content_type=None)
        token = result.get("token")
        if not token:
            raise MaxApiError(f"MAX upload did not return token: {result}")
        return str(token)

    async def send_excel(self, user_id: int, filename: str, content: bytes, text: str) -> None:
        token = await self.upload_file(filename, content)
        attachment = {"type": "file", "payload": {"token": token}}
        delay = 1.0
        for attempt in range(5):
            try:
                await self.send_message(user_id, text, attachments=[attachment])
                return
            except MaxApiError as exc:
                if "attachment.not.ready" not in str(exc) or attempt == 4:
                    raise
                await asyncio.sleep(delay)
                delay *= 2
